import { Command } from "@cliffy/command";
import { executeAsRootMac as executeAsRoot } from "@shuntd/core";

const PLIST_DESTINATION = "/Library/LaunchDaemons/com.shuntd.vram-guard.plist";

export const uninstallCommand = new Command()
    .description("Unload and remove the macOS LaunchDaemon.")
    .action(async () => {
        console.log("🗑️  Preparing to remove vram-mac-guard...");

        const rootScript = `
      # 1. Unload it from the kernel (ignore error if it's already unloaded)
      launchctl unload -w ${PLIST_DESTINATION} || true

      # 2. Delete the plist file
      rm -f ${PLIST_DESTINATION}
    `;

        console.log("🔐 Requesting system permissions to remove daemon...");

        try {
            await executeAsRoot(rootScript);
            console.log("✅ Successfully unloaded and removed vram-mac-guard!");
        } catch (error) {
            console.error("❌ Uninstall failed:");
            console.error(error.message);
        }
    });
