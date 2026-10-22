import { Command } from "@cliffy/command";
import { installCommand } from "./install.js";
import { restartCommand } from "./restart.js";
import { statusCommand } from "./status.js";
import { uninstallCommand } from "./uninstall.js";

export const serviceCommand = new Command()
    .description("Run shuntd as a user service (launchd or systemd).")
    .command("install", installCommand)
    .command("uninstall", uninstallCommand)
    .command("status", statusCommand)
    .command("restart", restartCommand);
