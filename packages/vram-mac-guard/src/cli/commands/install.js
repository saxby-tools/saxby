import { Command } from "@cliffy/command";
import {
    executeAsRootMac as executeAsRoot,
    generatePlist,
} from "@shuntd/core";
import { join } from "@std/path";
import {
    DAEMON_DIR,
    DAEMON_SCRIPT_DESTINATION,
    LABEL,
    LOG_ERROR,
    LOG_OUT,
    PLIST_DESTINATION,
} from "../../constants.js";

export const installCommand = new Command()
    .description("Install and load the macOS LaunchDaemon.")
    .option(
        "-v, --verbose",
        "Log raw `ollama ps` output on the daemon's first poll.",
    )
    .action(async (options) => {
        if (Deno.build.os !== "darwin") {
            console.error("❌ Error: vram-guard is only supported on macOS.");
            Deno.exit(1);
        }

        console.log("🔧 Preparing vram-mac-guard script and plist...");

        // 1. Read the bash script (Works locally AND from Deno compiled VFS)
        const localScriptPath = join(
            import.meta.dirname,
            "../../vram-mac-guard.sh",
        );
        const scriptContent = await Deno.readTextFile(localScriptPath);

        //  Same convention as SHUNTD_VERBOSE on the router: any non-empty
        //  value turns it on, so the variable is set only when asked for.
        const environment = {};

        if (options.verbose) {
            environment.VRAM_GUARD_VERBOSE = "1";
        }

        // 2. Generate the Plist targeting the physical libexec destination
        const plistContent = generatePlist({
            Label: LABEL,
            ProgramArguments: [
                "/usr/bin/env",
                "bash",
                DAEMON_SCRIPT_DESTINATION,
            ],
            EnvironmentVariables: environment,
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
            console.log("✅ Successfully installed and loaded vram-mac-guard!");
        } catch (error) {
            console.error("❌ Installation aborted or failed:", error.message);
        } finally {
            // Clean up temp files silently
            await Deno.remove(tempScriptPath).catch(() => {});
            await Deno.remove(tempPlistPath).catch(() => {});
        }
    });
