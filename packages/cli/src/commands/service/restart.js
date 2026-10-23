import { Command } from "@cliffy/command";
import { fail, prepare, reportAnswer, waitForAnswer } from "./shared.js";

//  The second half of deploying a build: the binary on disk changes,
//  the running process does not until it restarts.
export const restartCommand = new Command()
    .description("Restart the shuntd service, e.g. after a deploy.")
    .action(async (options) => {
        const { instance, adapter, config } = await prepare(options.instance);
        const before = await adapter.status(instance);

        if (!before.installed) {
            fail(
                `${adapter.name(instance)} is not installed. ` +
                    `Run 'shunt service install' first.`,
            );
        }

        try {
            await adapter.restart(instance);
        } catch (err) {
            fail(err.message);
        }

        const answer = await waitForAnswer(
            config.listen_port,
            instance,
            before.pid,
        );

        reportAnswer(answer, adapter, instance);
    });
