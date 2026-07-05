# shuntd

A local-first, config-driven AI routing suite.

## The Packages

- `@shuntd/llm-router`: The Unix-agnostic background daemon (`shuntd`) that intercepts and routes OpenAI-compatible traffic.
- `@shuntd/cli`: The user-facing orchestrator (`shunt`).
- `mac-vram-guard`: An isolated, Apple Silicon-specific LaunchDaemon to dynamically manage macOS Unified Memory based on LLM load.

## Lifecycle Semantics (V1)

- `shunt up`: Spawns the `shuntd` router as a detached background process and writes a PID file.
- `shunt down`: Reads the PID file, gracefully kills the router, and cleans up.
- `shunt status`: Verifies the port is alive and checks `mac-vram-guard` limits.
- **Note:** `mac-vram-guard` runs independently via macOS `launchd`. The CLI checks it, but does not own its lifecycle.
