import { Command } from "jsr:@cliffy/command@1.0.0-rc.4";

export const statusCommand = new Command()
    .description("Check the current memory limits and daemon status.")
    .action(async () => {
        console.log("📊 Fetching vram-mac-guard status...\n");

        // 1. Check if the daemon is actively loaded in launchd
        const launchctlCmd = new Deno.Command("launchctl", {
            args: ["list"],
            stdout: "piped",
        });
        const { stdout: launchOut } = await launchctlCmd.output();
        const isLoaded = new TextDecoder().decode(launchOut).includes("com.shuntd.vram-guard");

        console.log(`Daemon Loaded : ${isLoaded ? "✅ Yes" : "❌ No (Run 'shunt vram install')"}`);

        // 2. Check the current VRAM ceiling applied to the kernel
        const sysctlCmd = new Deno.Command("sysctl", {
            args: ["-n", "iogpu.wired_limit_mb"],
            stdout: "piped",
        });
        const { stdout: sysctlOut } = await sysctlCmd.output();
        const currentLimit = new TextDecoder().decode(sysctlOut).trim();

        console.log(`Current VRAM Limit : ${currentLimit} MB`);
    });
