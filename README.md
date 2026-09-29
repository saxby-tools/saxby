# shuntd

A local-first, config-driven AI routing suite.

## The Packages

- `@shuntd/llm-router`: The Unix-agnostic background daemon (`shuntd`) that intercepts and routes OpenAI-compatible traffic.
- `@shuntd/cli`: The user-facing orchestrator (`shunt`).
- `@shuntd/core`: Shared contracts — the canonical tag vocabulary, plist generation, privileged execution, env utilities.
- `mac-vram-guard`: An isolated, Apple Silicon-specific LaunchDaemon to dynamically manage macOS Unified Memory based on LLM load.

## Lifecycle Semantics (V1)

- `shunt up`: Spawns the `shuntd` router as a detached background process and writes a PID file.
- `shunt down`: Reads the PID file, gracefully kills the router, and cleans up.
- `shunt status`: Verifies the port is alive and checks `mac-vram-guard` limits.
- **Note:** `mac-vram-guard` runs independently via macOS `launchd`. The CLI checks it, but does not own its lifecycle.

## Routing Tiers

| Tier | Mechanism | Resolves to |
| ---- | --------- | ----------- |
| 1 | Explicit override (`/coder`, `shuntd/<model>`, raw model name) | Exactly what was asked for |
| 2a | Structural tags ∩ catalog `capabilities` | Best-scoring model |
| 2b | Structural tags ∩ persona `tags` | Persona's `default_model` |
| 3 | Semantic similarity against persona exemplars | Persona's `default_model` |
| — | Global fallback | `global_default_model` |

Ties in Tier 2a break by: overlap score, then persona-default preference, then name. A capability tag is a **routing preference**, not a capability claim — if two models claim the same tag, the tag stops differentiating.

## Auditing Routes

`POST /shuntd/explain` takes a `/v1/chat/completions` body and returns the full
routing decision as JSON — tier, tags, candidate scores, selected model, and an
abstention reason for every tier that declined. It **never contacts the
upstream**: no tokens generated, no models loaded, no VRAM moved.

```bash
curl http://127.0.0.1:11435/shuntd/explain \
  -H "Content-Type: application/json" \
  -d '{
    "model": "shuntd",
    "messages": [{"role":"user","content":"move the parser out of app/alpha.js into app/beta.js"}]
  }'
```

shuntd never touches the filesystem. File paths in prompts are matched by string
*shape* only — nothing is resolved, opened, or read. The paths above are
fictional and that is fine.

### Tests

```bash
deno task test
```

Unit tests are colocated with the code (`*.test.js`) and use fixture catalogs,
so they need no running daemon and no user config. Assertions that name real
models belong in a personal smoke script against `/shuntd/explain` rather than
in the suite — one machine's catalog is not a project invariant.

## Development Roadmap

- [x] **Milestone 1: The Config & Schema Chokepoint**
  - [x] Define Valibot schemas for `Persona`, `ModelCatalog`, and `Capabilities`.
  - [x] Establish the XDG-compliant config loader (crash-on-missing to enforce sane defaults).
  - [x] Build the `shunt config generate` interactive TUI.
  - [x] Implement the `OllamaAdapter` for hardware capability detection.
- [x] **Milestone 2: The Core Proxy & SSE Engine**
  - [x] Spin up the Deno HTTP server to intercept `POST /v1/chat/completions` and `GET /v1/models`.
  - [x] Implement transparent payload rewriting (swapping requested models for routed models).
  - [x] Handle Server-Sent Events (SSE) streaming proxy logic.
- [x] **Milestone 3: Tier 1 & Tier 2 Routing**
  - [x] Implement Tier 1 (Overrides): Parse prompts for explicit slash commands (`/coder`) or directives.
  - [x] Implement Tier 2 (Owned Extractor): Build lightweight lexical parser to detect code fences, formatting, and keywords to emit canonical capability tags.
  - [x] Build the `selectModel` gauntlet: Intersect emitted tags with the model catalog and pick the victor.
  - [x] Enforce the tag contract at boot; seed catalog capabilities from curated defaults.
  - [x] Add request tracing (`--verbose` / `--trace`) and the `/shuntd/explain` audit endpoint.
- [x] **Milestone 4: The SQLite Decision Logger**
  - [x] Wire up the Deno standard SQLite module.
  - [x] Create the schema for the transparent `decision_log` table.
  - [x] Asynchronously log prompt metadata, extracted tags, routing tier, and final model selection.
  - [x] Capture `client_id` so agent traffic and human traffic stay separable.
  - [x] Record delivery outcome via `info.completed` (fully streamed vs. aborted).
- [ ] **Milestone 5: Tier 3 Semantic Fallback**
  - [ ] Detect low-confidence Tier 2 resolutions.
  - [ ] Implement upstream `POST /v1/embeddings` requests.
  - [ ] Write Cosine Similarity math to compare incoming prompt vectors against cached persona exemplars.
  - [ ] Key the exemplar vector cache by embedding model so profiles can be A/B compared.
- [ ] **Milestone 6: MVP / v1 Release**
  - [ ] **Build & release**
    - [ ] `deno task build` cross-compiling `shuntd` and `shunt` for darwin-arm64, darwin-x64, linux-x64, linux-arm64.
    - [ ] `--include` the `vram-mac-guard.sh` asset so the compiled binary is self-contained.
    - [ ] Emit tarballs plus SHA256 checksums into `dist/`.
    - [ ] CI release workflow that attaches artifacts to a tagged GitHub release.
    - [ ] Packaging *scaffolding* only, not maintained repos: `packaging/nfpm.yaml` (deb/rpm), `packaging/PKGBUILD` template, `packaging/shuntd.rb` Homebrew formula template.
  - [ ] **Service management**
    - [ ] `ServiceAdapter` registry mirroring the backend adapter pattern: `LaunchdAdapter` (macOS) and `SystemdAdapter` (Linux).
    - [ ] `shunt service install | uninstall | status`, generating a user-level LaunchAgent or a `systemd --user` unit.
    - [ ] Persist Ollama environment (`OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_KEEP_ALIVE`) via the same adapter, since `launchctl setenv` does not survive a reboot.
    - [ ] Document the dev/prod split: `deno task dev` (`--watch`, no service) vs. compiled binary under a supervisor.
    - [ ] shunt audit — productize the live routing smoke test as a CLI command alongside shunt status.
  - [ ] **Documentation**
    - [ ] Create `docs/` — `getting-started.md`, `configuration.md`, `routing.md`, `services.md`, `clients.md`, `troubleshooting.md`, `architecture.md`.
    - [ ] Rewrite the README as a landing page that links into `docs/`.
  - [ ] **Client integration**
    - [ ] Point OpenClaw at shuntd and complete its onboarding.
    - [ ] Document Open WebUI setup, including the Task Model setting for background generation.

## Development

```bash
#  Run the router with hot reload and full tracing
deno task dev

#  Audit routing without generating a single token
deno task test

#  Regenerate config from live backend inventory
deno run -A packages/cli/src/main.js config generate
```
