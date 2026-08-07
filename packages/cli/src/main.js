import { Command } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/command/completions";
import { vramMacGuardCommand } from "@shuntd/vram-mac-guard";
import { configCommand } from "./commands/config/index.js";
import packageConfig from "../deno.json" with { type: "json" };

await new Command()
    .name("shunt")
    .version(packageConfig.version)
    .description("Local-first AI routing orchestrator.")
    .command("config", configCommand)
    .command("vram-mac-guard", vramMacGuardCommand)
    .command("completions", new CompletionsCommand())
    .parse(Deno.args);
