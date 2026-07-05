import { Command } from "jsr:@cliffy/command@1.0.0-rc.4";
import { vramCommand } from "../../vram-mac-guard/cli/index.js";

await new Command()
    .name("shunt")
    .version("0.1.0")
    .description("Local-first AI routing orchestrator.")
    .command("vram", vramCommand)
    .parse(Deno.args);
