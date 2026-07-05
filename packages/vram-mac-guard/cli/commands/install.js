import { Command } from "jsr:@cliffy/command@1.0.0-rc.4";
import { join } from "jsr:@std/path";
import { generatePlist } from "../../../core/src/utils/plist.js";
import { executeAsRootMac as executeAsRoot } from "../../../core/src/utils/root.js";

const VRAM_SCRIPT_PATH = join(import.meta.dirname, "../../mac-vram-guard.sh");
const PLIST_DESTINATION = "/Library/LaunchDaemons/com.shuntd.vram-guard.plist";

export const installCommand = new Command()
    .description("Install and load the macOS LaunchDaemon.")
    .action(async () => {
        if (Deno.build.os !== "darwin") {
            console.error("❌ Error: vram-guard is only supported on macOS.");
            Deno.exit(1);
        }

        console.log("🔧 Generating LaunchDaemon Plist...");
        const plistContent = generatePlist({
            Label: "com.shuntd.vram-guard",
            ProgramArguments: ["/usr/bin/env", "bash", VRAM_SCRIPT_PATH],
        });

        // 1. Write the XML to an unprivileged temporary file
        const tempFilePath = await Deno.makeTempFile({ suffix: ".plist" });
        await Deno.writeTextFile(tempFilePath, plistContent);

        // 2. Build the shell script for Apple to execute as root
        const rootScript = `cp ${tempFilePath} ${PLIST_DESTINATION}
            chown root:wheel ${PLIST_DESTINATION}
            chmod 644 ${PLIST_DESTINATION}
            launchctl load -w ${PLIST_DESTINATION}`;

        console.log("🔐 Requesting system permissions (Look for Touch ID prompt)...");

        try {
            await executeAsRoot(rootScript);
            console.log("✅ Successfully installed and loaded vram-mac-guard!");
        } catch (error) {
            console.error("❌ Installation aborted or failed:");
            console.error(error.message);
        } finally {
            // Clean up the temp file
            await Deno.remove(tempFilePath).catch(() => {});
        }
    });
