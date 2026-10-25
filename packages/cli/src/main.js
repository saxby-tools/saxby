import { Command } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/command/completions";
import { vramGuardMacCommand } from "@saxby/vram-guard-mac";
import { configCommand } from "./commands/config/index.js";
import { instanceCommand } from "./commands/instance/index.js";
import { probeCommand } from "./commands/probe.js";
import { serviceCommand } from "./commands/service/index.js";
import packageConfig from "../deno.json" with { type: "json" };

//  Global so `saxby -i dev config generate` and
//  `saxby config generate -i dev` both work. Commands that use an
//  instance pass options.instance to resolveInstanceName in core,
//  which falls back to SAXBY_INSTANCE.
await new Command()
    .name("saxby")
    .version(packageConfig.version)
    .description("Local-first AI routing orchestrator.")
    .globalOption(
        "-i, --instance <name:string>",
        "Target a named instance instead of the default instance.",
    )
    .command("config", configCommand)
    .command("instance", instanceCommand)
    .command("probe", probeCommand)
    .command("service", serviceCommand)
    .command("vram-guard-mac", vramGuardMacCommand)
    .command("completions", new CompletionsCommand())
    .parse(Deno.args);
