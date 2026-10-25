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

export class SystemdAdapter {
    static id = "systemd";
    static displayName = "systemd --user";

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

    static name(instance) {
        if (!instance) {
            return `${UNIT_BASE}.service`;
        }

        return `${UNIT_BASE}-${instance}.service`;
    }

    static path(instance) {
        return join(getConfigDir(), UNIT_DIR, this.name(instance));
    }

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

    static async uninstall(instance) {
        const unit = this.name(instance);

        await runCommand("systemctl", ["--user", "disable", "--now", unit]);
        await Deno.remove(this.path(instance)).catch(() => {});
        await systemctl(["daemon-reload"]);
    }

    static async restart(instance) {
        await systemctl(["restart", this.name(instance)]);
    }

    /**
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
