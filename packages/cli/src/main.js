import { Command } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/command/completions";
import { vramMacGuardCommand } from "@shuntd/vram-mac-guard";
import { configCommand } from "./commands/config/index.js";
import { instanceCommand } from "./commands/instance/index.js";
import { probeCommand } from "./commands/probe.js";
import { serviceCommand } from "./commands/service/index.js";
import packageConfig from "../deno.json" with { type: "json" };

//  Global so `shunt -i dev config generate` and
//  `shunt config generate -i dev` both work. Commands that use an
//  instance pass options.instance to resolveInstanceName in core,
//  which falls back to SHUNTD_INSTANCE.
await new Command()
    .name("shunt")
    .version(packageConfig.version)
    .description("Local-first AI routing orchestrator.")
    .globalOption(
        "-i, --instance <name:string>",
        "Target a named instance instead of the default.",
    )
    .command("config", configCommand)
    .command("instance", instanceCommand)
    .command("probe", probeCommand)
    .command("service", serviceCommand)
    .command("vram-mac-guard", vramMacGuardCommand)
    .command("completions", new CompletionsCommand())
    .parse(Deno.args);
