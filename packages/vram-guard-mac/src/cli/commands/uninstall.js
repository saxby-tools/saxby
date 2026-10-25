import { Command } from "@cliffy/command";
import { executeAsRootMac as executeAsRoot } from "@saxby/core";
import { DAEMON_DIR, PLIST_DESTINATION } from "../../constants.js";

export const uninstallCommand = new Command()
    .description("Unload and remove the macOS LaunchDaemon.")
    .action(async () => {
        console.log("🗑️  Preparing to remove vram-guard-mac...");

        const rootScript = `
            # 1. Unload it from the kernel (ignore error if it's already unloaded)
            launchctl unload -w ${PLIST_DESTINATION} || true

            # 2. Delete the plist file and the script directory
            rm -f ${PLIST_DESTINATION}
            rm -rf ${DAEMON_DIR}
        `;

        console.log("🔐 Requesting system permissions to remove daemon...");

        try {
            await executeAsRoot(rootScript);
            console.log("✅ Successfully unloaded and removed vram-guard-mac!");
        } catch (error) {
            console.error("❌ Uninstall failed:");
            console.error(error.message);
        }
    });
