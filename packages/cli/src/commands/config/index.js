import { Command } from "@cliffy/command";
import { generateCommand } from "./generate.js";

/**
 * `saxby config`, the parent of the config subcommands. It only
 * groups them; `generate` does the work.
 */
export const configCommand = new Command()
    .description("Manage Saxby configuration files.")
    .command("generate", generateCommand);
