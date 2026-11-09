//  =====================================================================
//  saxby status — is this instance's saxbyd answering?
//  =====================================================================
//  One line and an exit code, so a container HEALTHCHECK or a shell
//  script can ask without curl. Reads the instance's config for the
//  port and bind, then GET /saxby/v1/status, which saxbyd answers from
//  memory: no upstream call, no model load.
//
//    0   saxbyd is serving this instance on its port
//    1   nothing answers, something else holds the port, or the
//        config cannot be read
//
//  A saved config that saxbyd could not apply is a warning under the
//  line, and still exit 0: the daemon is serving, on the config it
//  had, so a health check must not restart it for that.

import { Command } from "@cliffy/command";
import {
    fetchInstanceStatus,
    instancePhrase,
    isPortHeld,
    listConfigWarnings,
    loadConfig,
    probeHostFor,
    resolveInstanceName,
} from "@saxby/core";

const EXIT_DOWN = 1;

function describeDown(port, probeHost) {
    if (isPortHeld(port, probeHost)) {
        return `port ${port} is held by a process that is not saxbyd`;
    }

    return `nothing is listening on ${probeHost}:${port}`;
}

export const statusCommand = new Command()
    .description(
        "Say whether this instance's saxbyd is answering; exit 1 if not.",
    )
    .action(async (options) => {
        let instance;
        let config;

        try {
            instance = resolveInstanceName(options.instance);
            config = await loadConfig(instance);
        } catch (err) {
            console.error(`❌ ${err.message}`);
            Deno.exit(EXIT_DOWN);
        }

        const port = config.listen_port;
        const probeHost = probeHostFor(config.listen_host);
        const holder = await fetchInstanceStatus(config, instance);

        if (!holder) {
            console.error(
                `❌ ${instancePhrase(instance)}: ` +
                    describeDown(port, probeHost),
            );
            Deno.exit(EXIT_DOWN);
        }

        if (holder.instance !== instance) {
            console.error(
                `❌ port ${port} is held by ` +
                    `${instancePhrase(holder.instance)} (pid ${holder.pid})`,
            );
            Deno.exit(EXIT_DOWN);
        }

        console.log(
            `✅ saxbyd ${holder.version ?? "?"} is serving ` +
                `${instancePhrase(instance)} on ${probeHost}:${port} ` +
                `(pid ${holder.pid})`,
        );

        for (const warning of listConfigWarnings(holder)) {
            console.warn(`⚠️  ${warning}`);
        }
    });
