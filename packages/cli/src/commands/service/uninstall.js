import { Command } from "@cliffy/command";
import { instancePhrase } from "@saxby/core";
import { fail, prepare } from "./shared.js";

export const uninstallCommand = new Command()
    .description("Stop Saxby and remove its user service.")
    .action(async (options) => {
        const { instance, adapter } = await prepare(options.instance);
        const service = await adapter.status(instance);

        //  Nothing to remove. Saying "Removed" here would claim an
        //  action that never happened.
        if (!service.installed && !service.loaded) {
            console.log(
                `${adapter.name(instance)} is not installed for ` +
                    `${instancePhrase(instance)}. Nothing to do.`,
            );
            return;
        }

        try {
            await adapter.uninstall(instance);
        } catch (err) {
            fail(err.message);
        }

        console.log(
            `✅ Removed ${adapter.name(instance)} for ` +
                `${instancePhrase(instance)}. ` +
                `Config, decision log and logs are kept.`,
        );
    });
