import { Command } from "@cliffy/command";
import { listCommand } from "./list.js";

/**
 * `saxby instance`, the parent of the instance subcommands. It only
 * groups them; `list` does the work.
 */
export const instanceCommand = new Command()
    .description("Inspect Saxby instances.")
    .command("list", listCommand);
