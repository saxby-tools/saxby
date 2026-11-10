/* @ts-self-types="./index.d.ts" */
/**
 * The Apple Silicon GPU memory ceiling daemon of Saxby, as a
 * `saxby vram-guard-mac` subcommand. It sets `iogpu.wired_limit_mb`
 * once, at boot, from a LaunchDaemon, so a backend started at login
 * reads the raised ceiling. macOS only, on purpose.
 *
 * @example Mount the command on a cliffy program
 * ```js
 * import { Command } from "@cliffy/command";
 * import { vramGuardMacCommand } from "@saxby/vram-guard-mac";
 *
 * await new Command()
 *     .command("vram-guard-mac", vramGuardMacCommand)
 *     .parse(Deno.args);
 * ```
 * @module
 */

export { vramGuardMacCommand } from "./cli/index.js";
