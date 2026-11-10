/**
 * `saxbyd`, the Saxby daemon. It sits in front of an OpenAI-compatible
 * backend and routes each chat request to the right local model,
 * logging every decision with its reasons. This entry point runs the
 * program and exports nothing; install it with
 * `deno install -g -n saxbyd jsr:@saxby/llm-router`.
 *
 * @example Run with routing trace output
 * ```bash
 * saxbyd --trace
 * ```
 * @module
 */
export {};
