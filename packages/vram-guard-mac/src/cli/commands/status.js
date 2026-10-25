import { Command } from "@cliffy/command";
import { LABEL } from "../../constants.js";

export const statusCommand = new Command()
    .description("Check the current memory limits and daemon status.")
    .action(async () => {
        console.log("📊 Fetching vram-guard-mac status...\n");

        // 1. Query the SYSTEM domain explicitly (does not require sudo to read)
        const launchctlCmd = new Deno.Command("launchctl", {
            args: ["print", `system/${LABEL}`],
            stdout: "piped",
            stderr: "piped",
        });

        // If exit code is 0, it found it. If it's non-zero, it's not loaded.
        const { code } = await launchctlCmd.output();
        const isLoaded = code === 0;

        console.log(
            `Daemon Loaded : ${
                isLoaded
                    ? "✅ Yes"
                    : "❌ No (Run 'saxby vram-guard-mac install')"
            }`,
        );

        // 2. Check the current VRAM ceiling applied to the kernel (readable by any user)
        const sysctlCmd = new Deno.Command("sysctl", {
            args: ["-n", "iogpu.wired_limit_mb"],
            stdout: "piped",
        });
        const { stdout: sysctlOut } = await sysctlCmd.output();
        const currentLimit = new TextDecoder().decode(sysctlOut).trim();

        console.log(`Current VRAM Limit : ${currentLimit} MB`);
    });
