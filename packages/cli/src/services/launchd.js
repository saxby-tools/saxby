//  =====================================================================
//  launchd — a per-user LaunchAgent
//  =====================================================================
//  A LaunchAgent, not a LaunchDaemon: the router runs as you, reads
//  your config, and needs no root. Labels follow the instance:
//
//    org.shuntd.router         default instance
//    org.shuntd.router.dev     named instance
//
//  Logs go to ~/Library/Logs/shuntd/, not /tmp, which macOS clears
//  on reboot — taking the evidence of a crash loop with it.

import { join } from "@std/path";
import { generatePlist, getHomeDir, SERVICE_PREFIX } from "@shuntd/core";
import { runCommand, runOrThrow } from "./run.js";

const ROUTER_LABEL = `${SERVICE_PREFIX}.router`;
const AGENTS_DIR = "Library/LaunchAgents";
const LOGS_DIR = "Library/Logs/shuntd";

//  launchd sends SIGTERM, then kills a job still running after its
//  ExitTimeOut, 20 seconds by default. Wait a little longer than that.
const UNLOAD_TIMEOUT_MS = 25_000;
const UNLOAD_POLL_MS = 250;

function domain() {
    return `gui/${Deno.uid()}`;
}

function logPaths(label) {
    const dir = join(getHomeDir(), LOGS_DIR);

    return {
        dir,
        out: join(dir, `${label}.out.log`),
        error: join(dir, `${label}.error.log`),
    };
}

async function isLoaded(label) {
    const result = await runCommand("launchctl", [
        "print",
        `${domain()}/${label}`,
    ]);

    return result.code === 0;
}

/**
 * Unloads a job and waits until launchd has let it go.
 *
 * `launchctl bootout` returns while the job may still be shutting
 * down — shuntd flushes its decision log on SIGTERM — and a bootstrap
 * that lands before it is gone fails with "5: Input/output error".
 * In a reinstall that left no service loaded at all.
 */
async function bootout(label) {
    await runOrThrow("launchctl", ["bootout", `${domain()}/${label}`]);

    const deadline = Date.now() + UNLOAD_TIMEOUT_MS;

    while (await isLoaded(label)) {
        if (Date.now() > deadline) {
            throw new Error(
                `${label} is still loaded ${UNLOAD_TIMEOUT_MS / 1000} s ` +
                    `after launchctl bootout. Check it with ` +
                    `'launchctl print ${domain()}/${label}'.`,
            );
        }

        await new Promise((resolve) => setTimeout(resolve, UNLOAD_POLL_MS));
    }
}

export class LaunchdAdapter {
    static id = "launchd";
    static displayName = "launchd";

    static isSupported() {
        return Deno.build.os === "darwin";
    }

    //  launchd is always present on macOS; nothing to check.
    static async preflight() {}

    static name(instance) {
        if (!instance) {
            return ROUTER_LABEL;
        }

        return `${ROUTER_LABEL}.${instance}`;
    }

    static path(instance) {
        const label = this.name(instance);

        return join(getHomeDir(), AGENTS_DIR, `${label}.plist`);
    }

    static logHint(instance) {
        return logPaths(this.name(instance)).out;
    }

    /**
     * The plist as text. Separate from install so it can be inspected
     * without touching launchd.
     */
    static render({ instance, binary, environment }) {
        const label = this.name(instance);
        const logs = logPaths(label);

        const args = [binary];

        if (instance) {
            args.push("--instance", instance);
        }

        const options = {
            Label: label,
            ProgramArguments: args,
            StandardOutPath: logs.out,
            StandardErrorPath: logs.error,
        };

        if (Object.keys(environment).length > 0) {
            options.EnvironmentVariables = environment;
        }

        return generatePlist(options);
    }

    static async install({ instance, binary, environment }) {
        const label = this.name(instance);
        const plistPath = this.path(instance);

        await Deno.mkdir(join(getHomeDir(), AGENTS_DIR), { recursive: true });
        await Deno.mkdir(logPaths(label).dir, { recursive: true });

        //  Reinstalling is updating: unload the old definition first,
        //  or bootstrap refuses a label that is already loaded.
        if (await isLoaded(label)) {
            await bootout(label);
        }

        const plist = this.render({ instance, binary, environment });

        await Deno.writeTextFile(plistPath, plist);
        await runOrThrow("launchctl", ["bootstrap", domain(), plistPath]);
    }

    static async uninstall(instance) {
        const label = this.name(instance);

        if (await isLoaded(label)) {
            await bootout(label);
        }

        await Deno.remove(this.path(instance)).catch(() => {});
    }

    static async restart(instance) {
        const label = this.name(instance);

        //  The service file can exist with nothing loaded — after a
        //  failed bootstrap, or `launchctl bootout` by hand. kickstart
        //  then says only "Could not find service".
        if (!(await isLoaded(label))) {
            throw new Error(
                `${label} is installed but not loaded, so there is ` +
                    `nothing to restart. Run 'shunt service install' ` +
                    `to load it.`,
            );
        }

        await runOrThrow("launchctl", [
            "kickstart",
            "-k",
            `${domain()}/${label}`,
        ]);
    }

    /**
     * @returns {Promise<{installed: boolean, loaded: boolean,
     *     pid: number | null}>}
     */
    static async status(instance) {
        const label = this.name(instance);

        let installed = true;

        try {
            await Deno.stat(this.path(instance));
        } catch {
            installed = false;
        }

        const result = await runCommand("launchctl", [
            "print",
            `${domain()}/${label}`,
        ]);

        if (result.code !== 0) {
            return { installed, loaded: false, pid: null };
        }

        //  Top-level "pid = N" only appears while the process runs.
        const match = result.stdout.match(/^\tpid = (\d+)$/m);
        const pid = match ? Number(match[1]) : null;

        return { installed, loaded: true, pid };
    }
}
