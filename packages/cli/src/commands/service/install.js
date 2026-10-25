import { Command } from "@cliffy/command";
import { join, resolve } from "@std/path";
import { fetchShuntdStatus } from "@shuntd/core";
import {
    displayName,
    fail,
    prepare,
    reportAnswer,
    waitForAnswer,
} from "./shared.js";

const BINARY_NAME = "shuntd";
const EXECUTABLE_BITS = 0o111;

//  Carried into the service so it reads the same config `shunt` just
//  checked. A supervisor does not inherit your shell's environment.
const FORWARDED_ENV = ["XDG_CONFIG_HOME"];

//  Set on every service. A service writes to a log file or the
//  journal, never a terminal, and Deno keeps color on regardless, so
//  the request logger's codes landed in the log as `[32m200[0m`.
//  Hono's logger and @std/fmt both honour NO_COLOR.
const SERVICE_ENV = { NO_COLOR: "1" };

async function isExecutableFile(path) {
    let info;

    try {
        info = await Deno.stat(path);
    } catch {
        return false;
    }

    if (!info.isFile) {
        return false;
    }

    return (info.mode & EXECUTABLE_BITS) !== 0;
}

async function findOnPath(name) {
    const dirs = (Deno.env.get("PATH") ?? "").split(":");

    for (const dir of dirs) {
        if (!dir) {
            continue;
        }

        const candidate = join(dir, name);

        if (await isExecutableFile(candidate)) {
            return candidate;
        }
    }

    return null;
}

/**
 * An absolute path to the binary the service will run, fixed at
 * install time. A service never searches PATH at boot.
 */
async function resolveBinary(flag) {
    if (flag) {
        const path = resolve(flag);

        if (!(await isExecutableFile(path))) {
            fail(`${path} is not an executable file.`);
        }

        return path;
    }

    const found = await findOnPath(BINARY_NAME);

    if (!found) {
        fail(
            `No '${BINARY_NAME}' on PATH. Deploy a build first ` +
                `(docs/releasing.md) or pass --bin <path>.`,
        );
    }

    return found;
}

function collectEnvironment() {
    const environment = { ...SERVICE_ENV };

    for (const key of FORWARDED_ENV) {
        const value = Deno.env.get(key);

        if (value) {
            environment[key] = value;
        }
    }

    return environment;
}

export const installCommand = new Command()
    .description("Install and start shuntd as a user service.")
    .option(
        "--bin <path:string>",
        "The shuntd binary to run. Defaults to shuntd on PATH.",
    )
    .action(async (options) => {
        const { instance, adapter, config } = await prepare(options.instance);
        const binary = await resolveBinary(options.bin);
        const port = config.listen_port;

        //  A shuntd already on this port outside the service — a dev
        //  run, a terminal left open — would put the new service into
        //  a crash loop. Reinstalling over our own service is fine.
        const service = await adapter.status(instance);
        const holder = await fetchShuntdStatus(port);

        if (holder && holder.pid !== service.pid) {
            fail(
                `:${port} is already served by instance ` +
                    `'${displayName(holder.instance)}' (pid ${holder.pid}) ` +
                    `outside this service. Stop it first.`,
            );
        }

        console.log(`🔧 ${adapter.displayName}: ${adapter.name(instance)}`);
        console.log(`   binary  ${binary}`);
        console.log(`   file    ${adapter.path(instance)}`);

        try {
            await adapter.install({
                instance,
                binary,
                environment: collectEnvironment(),
            });
        } catch (err) {
            fail(err.message);
        }

        const answer = await waitForAnswer(port, instance, service.pid);

        reportAnswer(answer, adapter, instance);
    });
