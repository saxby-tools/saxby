import { Command } from "@cliffy/command";
import { installCommand } from "./commands/install.js";
import { statusCommand } from "./commands/status.js";
import { uninstallCommand } from "./commands/uninstall.js";

export const vramMacGuardCommand = new Command()
    .description("Manage the hardware VRAM governor daemon.")
    .command("install", installCommand)
    .command("uninstall", uninstallCommand)
    .command("status", statusCommand);
