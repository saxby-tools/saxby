/**
 * `saxby`, the command-line tool for Saxby, a local-first LLM routing
 * daemon. This entry point runs the program and exports nothing;
 * install it with `deno install -g -n saxby jsr:@saxby/cli` and run
 * `saxby --help`.
 *
 * @example Write a config and run the daemon as a service
 * ```bash
 * saxby config generate
 * saxby service install
 * ```
 * @module
 */
export {};
