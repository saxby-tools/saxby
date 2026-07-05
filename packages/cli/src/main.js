import { Command } from "@cliffy/command";
import { vramMacGuardCommand } from "@shuntd/vram-mac-guard";

await new Command()
    .name("shunt")
    .version("0.1.0")
    .description("Local-first AI routing orchestrator.")
    .command("vram-mac-guard", vramMacGuardCommand)
    .parse(Deno.args);
