import { Command } from "@cliffy/command";
import { displayName, fail, prepare } from "./shared.js";

export const uninstallCommand = new Command()
    .description("Stop shuntd and remove its user service.")
    .action(async (options) => {
        const { instance, adapter } = await prepare(options.instance);

        try {
            await adapter.uninstall(instance);
        } catch (err) {
            fail(err.message);
        }

        console.log(
            `✅ Removed ${adapter.name(instance)} ` +
                `(instance '${displayName(instance)}'). ` +
                `Config, decision log and logs are kept.`,
        );
    });
