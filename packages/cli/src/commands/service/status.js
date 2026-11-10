import { Command } from "@cliffy/command";
import {
    fetchInstanceStatus,
    instanceLabel,
    instancePhrase,
    listConfigWarnings,
} from "@saxby/core";
import { prepare } from "./shared.js";

const LABEL_WIDTH = 10;

function line(label, value) {
    console.log(`${label.padEnd(LABEL_WIDTH)}${value}`);
}

function describeLoaded(service) {
    if (service.pid) {
        return `yes — pid ${service.pid}`;
    }

    if (service.loaded) {
        return "yes — not running";
    }

    return "no";
}

function describeAnswer(holder, instance) {
    if (!holder) {
        return "no";
    }

    if (holder.instance !== instance) {
        return `no — port held by ${instancePhrase(holder.instance)} ` +
            `(pid ${holder.pid})`;
    }

    return `yes — pid ${holder.pid}, version ${holder.version ?? "unknown"}`;
}

//  When the running config was read. A saxbyd from before live reload
//  does not say, and neither does a port nobody answers on.
function describeConfig(holder, instance) {
    if (!holder) {
        return "-";
    }

    if (holder.instance !== instance) {
        return "-";
    }

    if (!holder.config) {
        return "-";
    }

    return `loaded ${holder.config.loaded_at}`;
}

/**
 * `saxby service status`: whether the service file exists, whether
 * the supervisor has it loaded, and whether this instance answers on
 * its port, each on its own line. A saved config saxbyd could not
 * apply is printed as a warning under them.
 */
export const statusCommand = new Command()
    .description("Show whether the Saxby service is installed and up.")
    .action(async (options) => {
        const { instance, adapter, config } = await prepare(options.instance);
        const service = await adapter.status(instance);
        const holder = await fetchInstanceStatus(config, instance);

        line("Instance", instanceLabel(instance));
        line("Service", `${adapter.name(instance)} (${adapter.displayName})`);
        line("File", service.installed ? adapter.path(instance) : "-");

        line("Loaded", describeLoaded(service));
        line(`:${config.listen_port}`, describeAnswer(holder, instance));
        line("Config", describeConfig(holder, instance));
        line("Logs", adapter.logHint(instance));

        for (const warning of listConfigWarnings(holder)) {
            console.log(`\n⚠️  ${warning}`);
        }

        if (!service.installed) {
            console.log("\nNot installed. Run 'saxby service install'.");
        }
    });
