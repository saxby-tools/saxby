import { Command } from "@cliffy/command";
import { fetchShuntdStatus } from "@shuntd/core";
import { displayName, prepare } from "./shared.js";

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
        return `no — port held by instance ` +
            `'${displayName(holder.instance)}' (pid ${holder.pid})`;
    }

    return `yes — pid ${holder.pid}, version ${holder.version ?? "unknown"}`;
}

export const statusCommand = new Command()
    .description("Show whether the shuntd service is installed and up.")
    .action(async (options) => {
        const { instance, adapter, config } = await prepare(options.instance);
        const service = await adapter.status(instance);
        const holder = await fetchShuntdStatus(config.listen_port);

        line("Instance", displayName(instance));
        line("Service", `${adapter.name(instance)} (${adapter.displayName})`);
        line("File", service.installed ? adapter.path(instance) : "-");

        line("Loaded", describeLoaded(service));
        line(`:${config.listen_port}`, describeAnswer(holder, instance));
        line("Logs", adapter.logHint(instance));

        if (!service.installed) {
            console.log("\nNot installed. Run 'shunt service install'.");
        }
    });
