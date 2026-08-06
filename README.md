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

## Development Roadmap

- [x] **Milestone 1: The Config & Schema Chokepoint**
  - [x] Define Valibot schemas for `Persona`, `ModelCatalog`, and `Capabilities`.
  - [x] Establish the XDG-compliant config loader (crash-on-missing to enforce sane defaults).
  - [x] Build the `shunt config generate` interactive TUI.
  - [x] Implement the `OllamaAdapter` for hardware capability detection.
- [ ] **Milestone 2: The Core Proxy & SSE Engine**
  - [ ] Spin up the Deno HTTP server to intercept `POST /v1/chat/completions` and `GET /v1/models`.
  - [ ] Implement transparent payload rewriting (swapping requested models for routed models).
  - [ ] Handle Server-Sent Events (SSE) streaming proxy logic.
- [ ] **Milestone 3: Tier 1 & Tier 2 Routing**
  - [ ] Implement Tier 1 (Overrides): Parse prompts for explicit slash commands (`/coder`) or directives.
  - [ ] Implement Tier 2 (Owned Extractor): Build lightweight lexical parser to detect code fences, formatting, and keywords to emit canonical capability tags.
  - [ ] Build the `selectModel` gauntlet: Intersect emitted tags with the model catalog and pick the victor.
- [ ] **Milestone 4: The SQLite Decision Logger**
  - [ ] Wire up the Deno standard SQLite module.
  - [ ] Create the schema for the transparent `decision_log` table.
  - [ ] Asynchronously log prompt metadata, extracted tags, routing tier, and final model selection.
- [ ] **Milestone 5: Tier 3 Semantic Fallback**
  - [ ] Detect low-confidence Tier 2 resolutions.
  - [ ] Implement upstream `POST /v1/embeddings` requests.
  - [ ] Write Cosine Similarity math to compare incoming prompt vectors against cached persona exemplars.
