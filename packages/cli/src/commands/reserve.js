//  =====================================================================
//  saxby reserve — run a heavy GPU job inside a memory reservation
//  =====================================================================
//
//    saxby [-i <name>] reserve --gib <N> [--timeout <s>]
//        [--label <text>] [--no-broker] -- <command> [args...]
//
//  The `--` is required: everything after it is the job, untouched, so
//  the job's own flags can never be read as saxby's.
//
//  The flow, the exit codes and the signal rules live in
//  reserve/run.js; this file only gathers the real effects for it.
//  docs/memory-broker.md is the guide.

import { Command } from "@cliffy/command";
import { basename } from "@std/path";
import { findMemoryProbe, loadConfig, resolveInstanceName } from "@saxby/core";
import { findMemoryLimiters } from "../limiters/index.js";
import { createReservationClient } from "../reserve/client.js";
import { EXIT_UNAVAILABLE, EXIT_USAGE, runReserved } from "../reserve/run.js";

const LABEL_MAX_LENGTH = 64;

//  Messages go to stderr, so a job's stdout stays the job's own.
function say(line) {
    console.error(line);
}

function spawnChild(command, args, env) {
    const child = new Deno.Command(command, {
        args,
        env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    }).spawn();

    return {
        pid: child.pid,
        status: child.status,
        kill: (signal) => {
            try {
                child.kill(signal);
            } catch {
                //  It already exited.
            }
        },
    };
}

function onSignal(name, handler) {
    Deno.addSignalListener(name, handler);

    return () => Deno.removeSignalListener(name, handler);
}

function every(ms, fn) {
    const timer = setInterval(fn, ms);

    return () => clearInterval(timer);
}

//  The log keeps the command's name only, never its arguments.
function labelFor(command, given) {
    if (given) {
        return given;
    }

    return basename(command).slice(0, LABEL_MAX_LENGTH);
}

/**
 * The instance's port and default wait. Without a config there is no
 * saxbyd to ask, so that fails closed like an unreachable one.
 */
async function readInstance(options) {
    let instance;
    let config;

    try {
        instance = resolveInstanceName(options.instance);
        config = await loadConfig(instance);
    } catch (err) {
        say(err.message);
        say(
            "saxby reserve: refusing to run without a broker to ask. " +
                "Run anyway with --no-broker.",
        );

        return null;
    }

    return {
        port: config.listen_port,
        waitS: config.memory.wait_timeout_s,
    };
}

export const reserveCommand = new Command()
    .description(
        "Run a command once saxbyd has reserved GPU memory for it. " +
            "Put the command after --.",
    )
    .option("--gib <gib:number>", "GPU memory to reserve, in GiB.", {
        required: true,
    })
    .option(
        "--timeout <seconds:number>",
        "How long to wait for room. Default: memory.wait_timeout_s.",
    )
    .option("--label <text:string>", "Name for the log. Default: the command.")
    .option(
        "--no-broker",
        "Run without asking saxbyd. Unsafe: prints a warning.",
    )
    .example("Upscale", "saxby reserve --gib 12 -- upscayl-bin -i in.png")
    .action(async function (options) {
        const [command, ...args] = this.getLiteralArgs();

        if (!command) {
            say("saxby reserve: name the command after --.");
            Deno.exit(EXIT_USAGE);
        }

        if (!(options.gib > 0)) {
            say("saxby reserve: --gib must be greater than 0.");
            Deno.exit(EXIT_USAGE);
        }

        if (options.timeout !== undefined && !(options.timeout >= 0)) {
            say("saxby reserve: --timeout must be 0 or more.");
            Deno.exit(EXIT_USAGE);
        }

        const plan = {
            gib: options.gib,
            timeoutS: options.timeout,
            label: labelFor(command, options.label),
            command,
            args,
            useBroker: options.broker,
        };

        const deps = {
            client: null,
            probe: findMemoryProbe(),
            limiters: findMemoryLimiters(),
            pid: Deno.pid,
            port: null,
            say,
            onSignal,
            every,
            spawn: spawnChild,
        };

        if (plan.useBroker) {
            const instance = await readInstance(options);

            if (!instance) {
                Deno.exit(EXIT_UNAVAILABLE);
            }

            plan.timeoutS = plan.timeoutS ?? instance.waitS;
            deps.port = instance.port;
            deps.client = createReservationClient(instance.port);
        }

        Deno.exit(await runReserved(plan, deps));
    });
