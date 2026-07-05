import { Command } from "jsr:@cliffy/command@1.0.0-rc.4";
import { join } from "jsr:@std/path";
import { generatePlist } from "../../../core/src/utils/plist.js";

// Note: import.meta.dirname is now one level deeper
const VRAM_SCRIPT_PATH = join(import.meta.dirname, "../../mac-vram-guard.sh");

export const installCommand = new Command()
  .description("Install and load the macOS LaunchDaemon.")
  .action(async () => {
    if (Deno.build.os !== "darwin") {
      console.error("❌ Error: vram-guard is only supported on macOS.");
      Deno.exit(1);
    }

    console.log(`🔧 Generating Plist pointing to: ${VRAM_SCRIPT_PATH}`);

    const plistContent = generatePlist({
      Label: "com.shuntd.vram-guard",
      ProgramArguments: ["/usr/bin/env", "bash", VRAM_SCRIPT_PATH],
      StandardErrorPath: "/var/log/vram-mac-guard.error.log",
      StandardOutPath: "/var/log/vram-mac-guard.out.log"
    });

    console.log(plistContent);
    console.log("✅ Ready to execute install sequence.");
  });
