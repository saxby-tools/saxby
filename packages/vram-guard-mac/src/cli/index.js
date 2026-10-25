import { Command } from "@cliffy/command";
import { installCommand } from "./commands/install.js";
import { statusCommand } from "./commands/status.js";
import { uninstallCommand } from "./commands/uninstall.js";

//  noGlobals: the guard is one machine-wide daemon, not per instance,
//  so saxby's global -i/--instance would do nothing here. Hidden from
//  help and refused when given after this command. `saxby -i dev
//  vram-guard-mac` still parses, since the top-level command owns -i.
export const vramGuardMacCommand = new Command()
    .description("Manage the hardware VRAM governor daemon.")
    .noGlobals()
    .command("install", installCommand)
    .command("uninstall", uninstallCommand)
    .command("status", statusCommand);
