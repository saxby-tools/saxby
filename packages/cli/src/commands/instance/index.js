import { Command } from "@cliffy/command";
import { listCommand } from "./list.js";

export const instanceCommand = new Command()
    .description("Inspect shuntd instances.")
    .command("list", listCommand);
