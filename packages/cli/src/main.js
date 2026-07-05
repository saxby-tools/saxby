import { Command } from "@cliffy/command";
import { vramCommand } from "@shuntd/vram-mac-guard";

await new Command()
    .name("shunt")
    .version("0.1.0")
    .description("Local-first AI routing orchestrator.")
    .command("vram", vramCommand)
    .parse(Deno.args);
