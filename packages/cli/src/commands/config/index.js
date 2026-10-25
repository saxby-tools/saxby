import { Command } from "@cliffy/command";
import { generateCommand } from "./generate.js";

export const configCommand = new Command()
    .description("Manage Saxby configuration files.")
    .command("generate", generateCommand);
