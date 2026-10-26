#  Roadmap

Milestones and their phases, ticked as they land. Open questions and
ideas past v1 live in
[Discussions](https://github.com/saxby-tools/saxby/discussions);
known gaps are issues labelled
[`known-gap`](https://github.com/saxby-tools/saxby/issues?q=label%3Aknown-gap).

- [x] **Milestone 1: The Config & Schema Chokepoint**
  - [x] Define Valibot schemas for `Persona`, `ModelCatalog`, and `Capabilities`.
  - [x] Establish the XDG-compliant config loader (crash-on-missing to enforce sane defaults).
  - [x] Build the `saxby config generate` interactive TUI.
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
  - [x] Add request tracing (`--verbose` / `--trace`) and the `/saxby/v1/explain` audit endpoint.
- [x] **Milestone 4: The SQLite Decision Logger**
  - [x] Wire up the Deno standard SQLite module.
  - [x] Create the schema for the transparent `decision_log` table.
  - [x] Asynchronously log prompt metadata, extracted tags, routing tier, and final model selection.
  - [x] Capture `client_id` so agent traffic and human traffic stay separable.
  - [x] Record delivery outcome via `info.completed` (fully streamed vs. aborted).
- [x] **Milestone 5: Tier 3 Semantic Fallback**
  - [x] Detect low-confidence Tier 2 resolutions.
  - [x] Implement upstream `POST /v1/embeddings` requests.
  - [x] Write Cosine Similarity math to compare incoming prompt vectors against cached persona exemplars.
  - [x] Key the exemplar vector cache by embedding model so profiles can be A/B compared.
- [ ] **Milestone 6: MVP / v1 Release**
  - [x] **Phase 0 — Instances** *(everything else assumes this)*
    - [x] `getInstanceDir(name)` in `@saxby/core`, replacing the
          current `join(getConfigDir(), "saxby")`. No name resolves
          to the config root; a name resolves to
          `instances/<name>/`. Existing installs keep working with
          no migration. Names are limited to lowercase letters,
          digits and hyphens, since one name becomes a folder, a
          launchd label and a systemd unit.
    - [x] Global `--instance` / `-i` flag on `saxby`, plus a
          `SAXBY_INSTANCE` environment variable so tasks set it
          once.
    - [x] Per-instance isolation of config, decision log and
          exemplar vectors. The vectors live inside the log, so that
          falls out for free — note that switching instances
          re-embeds exemplars on first boot.
    - [x] `saxby instance list` — names, ports, whether each is
          running, and its pid, read from `/saxby/v1/status`. The
          "service installed" column lands with Phase 2.
    - [x] Friendly `EADDRINUSE` on boot, naming the instance already
          holding the port rather than surfacing a raw bind error.
    - [x] `deno task dev` — `--watch` against the dev instance on a
          non-default port, so the service keeps running and the
          default instance's archive stays clean.
    - [x] `saxby probe` — productize `.scratch/probe-semantic.js`
          as a CLI command, instance-aware. It reports scores and
          margins rather than asserting expected models, so it
          carries no one machine's catalog. Lands here so every
          later phase can be verified with one command.
  - [x] **Phase 1 — Build**
    - [x] `deno task build` cross-compiling `saxbyd` and `saxby` for
          darwin-arm64, darwin-x64, linux-x64, linux-arm64.
    - [x] `--include` the
          [`vram-guard-mac.sh`](../packages/vram-guard-mac/src/vram-guard-mac.sh)
          asset so the compiled binary is self-contained.
    - [x] Emit tarballs plus SHA256 checksums into `dist/`.
    - [x] [Releasing](releasing.md) — the checklist. Four targets, four
          checksums, a tag, and a local deploy. Packaging templates
          join it in Phase 3. This works by hand the first time and
          drifts silently by the third.
  - [x] **Phase 2 — Service management**
    - [x] `ServiceAdapter` registry mirroring the backend adapter
          pattern: `LaunchdAdapter` (macOS), `SystemdAdapter`
          (Linux). Instance-aware from the start — a label cannot be
          `tools.saxby.router` for two instances.
    - [x] `saxby service install | uninstall | status | restart`,
          generating a user-level LaunchAgent or a `systemd --user`
          unit. `restart` is the second half of deploying a build.
    - [x] "Service installed" column in `saxby instance list`.
    - [x] A per-platform recipe in `docs/` for persisting backend
          environment variables (`OLLAMA_MAX_LOADED_MODELS`,
          `OLLAMA_KEEP_ALIVE`, ...). Saxby does not set them: the
          backend runs under its own supervisor, which owns its
          environment.
    - [x] Document the dev instance beside the default instance:
          `deno task dev` versus a compiled binary under a supervisor,
          plus the explicit third mode — stop the service and run the
          source tree as the default instance when you want real
          client traffic through it.
    - [x] Verify `SystemdAdapter` on a real systemd host. Run end
          to end on Arch from a makepkg-installed `saxby-bin`:
          install, status, restart, and uninstall.
  - [x] **Phase 3 — Release automation**
    - [x] CI release workflow that attaches artifacts to a tagged
          GitHub release.
    - [x] Packaging *scaffolding* only, not maintained repos:
          [`packaging/nfpm.yaml`](../packaging/nfpm.yaml) (deb/rpm),
          [`packaging/PKGBUILD`](../packaging/PKGBUILD) template,
          [`packaging/saxby.rb`](../packaging/saxby.rb) Homebrew
          formula template.
  - [ ] **Phase 4 — Documentation** *(last: it documents a surface
        that is still moving until Phase 2 lands)*
    - [ ] JSDoc sweep (#26), consistent across the repo. Mechanical and
          verifiable with `deno check` — safe to start any time, and
          independent of the phases above.
    - [x] Create `docs/` — [Getting started](getting-started.md),
          [Configuration](configuration.md), [Instances](instances.md),
          [Routing](routing.md), [Services](services.md),
          [Clients](clients.md), [Releasing](releasing.md),
          [Troubleshooting](troubleshooting.md),
          [Architecture](architecture.md).
    - [x] Rewrite the README as a landing page that links into
          `docs/`.
    - [x] [Clients](clients.md): how to point OpenClaw at Saxby, and
          Open WebUI setup including the Task Model setting for
          background generation. Cover the layer-ownership rule —
          when a UI sits in front of an agent, every capability the
          UI also provides is a second opinion about something
          already decided downstream.
  - [ ] **Phase 5 — Publishing** *(tracked by the
        [v1.0.0 milestone](https://github.com/saxby-tools/saxby/milestone/1);
        v1.0.0 ships when it is empty)*
    - [x] `v0.9.0` pre-release: proves the tag path of the release
          workflow (#4) and gives the packages real artifacts.
    - [x] Homebrew tap, published from the release workflow (#23).
    - [x] `saxby-bin` on the AUR, published from the release
          workflow (#24).
    - [x] JSR packages under `@saxby`, published from CI (#25).
    - [x] Quick gaps: #5, #6, #10, #11, #13.
