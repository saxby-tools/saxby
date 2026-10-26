import { Command } from "@cliffy/command";
import {
    executeAsRootMac as executeAsRoot,
    generatePlist,
} from "@saxby/core";
import {
    DAEMON_DIR,
    DAEMON_SCRIPT_DESTINATION,
    LABEL,
    LOG_ERROR,
    LOG_OUT,
    PLIST_DESTINATION,
} from "../../constants.js";

//  By URL, not by path, so one read works everywhere this code runs:
//  a checkout (file:), a compiled binary (file:, embedded with
//  --include by scripts/build.js) and JSR (https:). A path built from
//  import.meta.dirname fails on JSR, where that is undefined.
const SCRIPT_URL = new URL("../../vram-guard-mac.sh", import.meta.url);

async function readScript() {
    const response = await fetch(SCRIPT_URL);

    if (!response.ok) {
        throw new Error(
            `Could not read ${SCRIPT_URL.href} (HTTP ${response.status}).`,
        );
    }

    return await response.text();
}

export const installCommand = new Command()
    .description("Install and load the macOS LaunchDaemon.")
    .action(async () => {
        if (Deno.build.os !== "darwin") {
            console.error("❌ Error: vram-guard is only supported on macOS.");
            Deno.exit(1);
        }

        console.log("🔧 Preparing vram-guard-mac script and plist...");

        // 1. Read the bash script
        const scriptContent = await readScript();

        // 2. Generate the Plist targeting the physical libexec destination
        //  KeepAlive off: the script sets the ceiling once and exits on
        //  purpose, and launchd would otherwise relaunch it forever.
        const plistContent = generatePlist({
            Label: LABEL,
            ProgramArguments: [
                "/usr/bin/env",
                "bash",
                DAEMON_SCRIPT_DESTINATION,
            ],
            KeepAlive: false,
            StandardErrorPath: LOG_ERROR,
            StandardOutPath: LOG_OUT,
        });

        // 3. Write BOTH payloads to unprivileged temp files first
        const tempScriptPath = await Deno.makeTempFile({ suffix: ".sh" });
        await Deno.writeTextFile(tempScriptPath, scriptContent);

        const tempPlistPath = await Deno.makeTempFile({ suffix: ".plist" });
        await Deno.writeTextFile(tempPlistPath, plistContent);

        // 4. The Single Root Transaction: Move, permission, and load everything at once
        const rootScript = `
            mkdir -p ${DAEMON_DIR}
            cp ${tempScriptPath} ${DAEMON_SCRIPT_DESTINATION}
            chmod +x ${DAEMON_SCRIPT_DESTINATION}

            cp ${tempPlistPath} ${PLIST_DESTINATION}
            chown root:wheel ${PLIST_DESTINATION}
            chmod 644 ${PLIST_DESTINATION}

            launchctl load -w ${PLIST_DESTINATION}
        `;

        console.log(
            "🔐 Requesting system permissions (Look for Touch ID prompt)...",
        );

        try {
            await executeAsRoot(rootScript);
            console.log("✅ Successfully installed and loaded vram-guard-mac!");

            //  Backends read the ceiling once, when they start. One that
            //  is already running keeps the old value until restarted.
            console.log(
                "ℹ️  If your backend is already running, restart it once " +
                    "so it reads the new ceiling.",
            );
        } catch (error) {
            console.error("❌ Installation aborted or failed:", error.message);
        } finally {
            // Clean up temp files silently
            await Deno.remove(tempScriptPath).catch(() => {});
            await Deno.remove(tempPlistPath).catch(() => {});
        }
    });
