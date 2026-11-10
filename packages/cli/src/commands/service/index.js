import { Command } from "@cliffy/command";
import { installCommand } from "./install.js";
import { restartCommand } from "./restart.js";
import { statusCommand } from "./status.js";
import { uninstallCommand } from "./uninstall.js";

/**
 * `saxby service`, the parent of the service subcommands. Each one
 * works through the platform's ServiceAdapter, so the same commands
 * drive a LaunchAgent on macOS and a `systemd --user` unit on Linux.
 */
export const serviceCommand = new Command()
    .description("Run Saxby as a user service (launchd or systemd).")
    .command("install", installCommand)
    .command("uninstall", uninstallCommand)
    .command("status", statusCommand)
    .command("restart", restartCommand);
