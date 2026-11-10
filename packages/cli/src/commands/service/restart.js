import { Command } from "@cliffy/command";
import { fail, prepare, reportAnswer, waitForAnswer } from "./shared.js";

/**
 * `saxby service restart`: the second half of deploying a build. The
 * binary on disk changes; the running process does not until it
 * restarts. Waits until a new process answers on the port, so an old
 * one still shutting down is not reported as success.
 */
export const restartCommand = new Command()
    .description("Restart the Saxby service, e.g. after a deploy.")
    .action(async (options) => {
        const { instance, adapter, config } = await prepare(options.instance);
        const before = await adapter.status(instance);

        if (!before.installed) {
            fail(
                `${adapter.name(instance)} is not installed. ` +
                    `Run 'saxby service install' first.`,
            );
        }

        try {
            await adapter.restart(instance);
        } catch (err) {
            fail(err.message);
        }

        const answer = await waitForAnswer(config, instance, before.pid);

        reportAnswer(answer, adapter, instance);
    });
