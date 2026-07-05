import { Command } from "jsr:@cliffy/command@1.0.0-rc.4";
import { installCommand } from "./commands/install.js";
import { statusCommand } from "./commands/status.js";
import { uninstallCommand } from "./commands/uninstall.js";

export const vramCommand = new Command()
    .description("Manage the hardware VRAM governor daemon.")
    .command("install", installCommand)
    .command("uninstall", uninstallCommand)
    .command("status", statusCommand);
