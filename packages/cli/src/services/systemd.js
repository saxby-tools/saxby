//  =====================================================================
//  systemd — a `systemd --user` unit
//  =====================================================================
//  A user unit, not a system one: the router runs as you, reads your
//  config, and needs no root. Plain units rather than a template, so
//  the default instance keeps the plain name:
//
//    saxbyd.service            default instance
//    saxbyd-dev.service        named instance
//
//  User units stop at logout unless lingering is enabled for the
//  user (`loginctl enable-linger`). On a desktop that is usually what
//  you want; on a headless box it is not. Saxby does not change it.
//
//  No After=network-online.target: that target lives in the system
//  manager, so a user unit cannot see it and the line would be dead.
//  saxbyd binds a local port at boot and copes with an unreachable
//  upstream on its own.
//
//  Logs go to the journal: `journalctl --user -u saxbyd`.

import { join } from "@std/path";
import { getConfigDir, instancePhrase } from "@saxby/core";
import { COMMAND_NOT_FOUND, runCommand, runOrThrow } from "./run.js";

const UNIT_BASE = "saxbyd";
const UNIT_DIR = "systemd/user";
const RESTART_SEC = 5;

//  systemd splits ExecStart on whitespace and reads `"` and `\`, so
//  every argument and assignment is quoted with those escaped.
function quote(value) {
    const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

    return `"${escaped}"`;
}

function systemctl(args) {
    return runOrThrow("systemctl", ["--user", ...args]);
}

/**
 * The ServiceAdapter for Linux: saxbyd as a `systemd --user` unit,
 * driven through `systemctl --user`. Static, like the backend
 * adapters; nothing is instantiated.
 */
export class SystemdAdapter {
    /** The adapter's key, as a config or a log names it. */
    static id = "systemd";

    /** What `saxby service status` prints as the supervisor. */
    static displayName = "systemd --user";

    /**
     * True on Linux. Whether this session has a user manager is
     * preflight's question, since a container may not.
     * @returns {boolean}
     */
    static isSupported() {
        return Deno.build.os === "linux";
    }

    /**
     * Fails loudly when there is no user manager to talk to, rather
     * than writing a unit file nothing can load. Containers and some
     * minimal installs run without one.
     */
    static async preflight() {
        const result = await runCommand("systemctl", [
            "--user",
            "show-environment",
        ]);

        if (result.code === COMMAND_NOT_FOUND) {
            throw new Error("systemctl was not found. Is this a systemd host?");
        }

        if (result.code !== 0) {
            throw new Error(
                "systemd --user is not available in this session: " +
                    result.stderr.trim(),
            );
        }
    }

    /**
     * The unit name for an instance: `saxbyd.service` for the default
     * instance, `saxbyd-<name>.service` for a named one.
     * @param {string | null} instance
     * @returns {string}
     */
    static name(instance) {
        if (!instance) {
            return `${UNIT_BASE}.service`;
        }

        return `${UNIT_BASE}-${instance}.service`;
    }

    /**
     * Where the instance's unit file lives, under the user's
     * systemd/user config directory.
     * @param {string | null} instance
     * @returns {string}
     */
    static path(instance) {
        return join(getConfigDir(), UNIT_DIR, this.name(instance));
    }

    /**
     * The command to run when the service does not answer. Logs go to
     * the journal, so this is a `journalctl` line, not a file.
     * @param {string | null} instance
     * @returns {string}
     */
    static logHint(instance) {
        return `journalctl --user -u ${this.name(instance)}`;
    }

    /**
     * The unit as text. Separate from install so it can be inspected
     * without touching systemd.
     */
    static render({ instance, binary, environment }) {
        const args = [binary];

        if (instance) {
            args.push("--instance", instance);
        }

        const lines = [
            "[Unit]",
            `Description=Saxby LLM router (${instancePhrase(instance)})`,
            "",
            "[Service]",
            `ExecStart=${args.map(quote).join(" ")}`,
            "Restart=on-failure",
            `RestartSec=${RESTART_SEC}`,
        ];

        for (const [key, value] of Object.entries(environment)) {
            lines.push(`Environment=${quote(`${key}=${value}`)}`);
        }

        lines.push("", "[Install]", "WantedBy=default.target", "");

        return lines.join("\n");
    }

    /**
     * Writes the unit file, enables it and restarts it, so a reinstall
     * picks up the new unit rather than keeping the old process.
     * @param {Object} spec
     * @param {string | null} spec.instance
     * @param {string} spec.binary - Absolute path to saxbyd.
     * @param {Object<string, string>} spec.environment - Variables the
     *     service runs with.
     * @returns {Promise<void>}
     * @throws {Error} when systemctl fails, with its own stderr.
     */
    static async install({ instance, binary, environment }) {
        const unit = this.name(instance);
        const unitPath = this.path(instance);

        await Deno.mkdir(join(getConfigDir(), UNIT_DIR), { recursive: true });

        const text = this.render({ instance, binary, environment });

        await Deno.writeTextFile(unitPath, text);

        await systemctl(["daemon-reload"]);
        await systemctl(["enable", unit]);

        //  restart, not start: a reinstall must pick up the new unit.
        await systemctl(["restart", unit]);
    }

    /**
     * Stops and disables the unit, removes its file and reloads the
     * manager. A unit systemd never knew is not an error.
     * @param {string | null} instance
     * @returns {Promise<void>}
     */
    static async uninstall(instance) {
        const unit = this.name(instance);

        await runCommand("systemctl", ["--user", "disable", "--now", unit]);
        await Deno.remove(this.path(instance)).catch(() => {});
        await systemctl(["daemon-reload"]);
    }

    /**
     * Restarts the unit with `systemctl --user restart`.
     * @param {string | null} instance
     * @returns {Promise<void>}
     * @throws {Error} when systemctl fails, with its own stderr.
     */
    static async restart(instance) {
        await systemctl(["restart", this.name(instance)]);
    }

    /**
     * Whether the unit file exists, whether the unit is active, and
     * its main pid while it runs. `loaded` is "active" here, since a
     * user unit that is not running is not held by the manager.
     * @param {string | null} instance
     * @returns {Promise<{installed: boolean, loaded: boolean,
     *     pid: number | null}>}
     */
    static async status(instance) {
        let installed = true;

        try {
            await Deno.stat(this.path(instance));
        } catch {
            installed = false;
        }

        const result = await runCommand("systemctl", [
            "--user",
            "show",
            this.name(instance),
            "--property=ActiveState,MainPID",
        ]);

        if (result.code !== 0) {
            return { installed, loaded: false, pid: null };
        }

        const active = /^ActiveState=active$/m.test(result.stdout);
        const match = result.stdout.match(/^MainPID=(\d+)$/m);
        const pid = match && match[1] !== "0" ? Number(match[1]) : null;

        return { installed, loaded: active, pid };
    }
}
