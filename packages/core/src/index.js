/**
 * Shared contracts for Saxby, a local-first LLM routing daemon:
 * the config schema and loader, instance folders, the API token,
 * backend adapters, memory probes, service labels and the tag
 * vocabulary. `saxby config generate` writes what `saxbyd` reads,
 * and this package is the agreement between them.
 *
 * @example Load an instance's config
 * ```js
 * import { loadConfig, resolveInstanceName } from "@saxby/core";
 *
 * const config = await loadConfig(resolveInstanceName("dev"));
 * ```
 * @module
 */

export * from "./utils/env.js";
export * from "./utils/fetch-error.js";
export * from "./utils/plist.js";
export * from "./utils/probe.js";
export * from "./utils/root.js";
export * from "./config/instance.js";
export * from "./config/schema.js";
export * from "./config/loader.js";
export * from "./config/token.js";
export * from "./backends/index.js";
export * from "./memory/units.js";
export * from "./memory/probes/index.js";
export * from "./service/index.js";
export * from "./tags/index.js";
