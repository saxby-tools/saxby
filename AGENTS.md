#  shuntd

A local-first LLM routing daemon in a Deno/JSR monorepo. It sits in
front of an OpenAI-compatible backend, listens on `:11435`, and routes
each request to the right local model. The goal is closing the gap to
a frontier-model experience on owned hardware, with a transparent
archive of every routing decision so the system gets tuned against
evidence rather than intuition.

##  Packages

```
packages/core            shared contracts: tag vocabulary, plist, root
packages/cli             `shunt` — config generation, vram-mac-guard
packages/llm-router      `shuntd` — the daemon
packages/vram-mac-guard  Apple Silicon VRAM ceiling LaunchDaemon
```

##  Routing tiers

| Tier | Mechanism | Resolves to |
| ---- | --------- | ----------- |
| 1 | `/coder`, `shuntd/<model>` bypass, raw model name | exactly what was asked |
| 2a | structural tags ∩ catalog `capabilities` | best-scoring model |
| 2b | structural tags ∩ persona `tags` | persona `default_model` |
| 3 | embedding similarity vs persona exemplars | persona `default_model` |
| — | global fallback | `global_default_model` |

Tiers 1 and 2 are synchronous. Tier 3 makes one embedding call and
runs **only** when 1 and 2 both abstain, so the fast path never
awaits. `resolveIntent` stays sync; `resolvePipeline` is async.

Every tier that declines records a REASON. A silent fallback made a
config bug look like correct behaviour once already — see the
capabilities story below.

##  Commands

```bash
deno task test                                    # unit tests
deno run -A packages/llm-router/src/main.js --trace
deno run -A packages/cli/src/main.js config generate
deno check packages/cli/src/main.js
```

`POST /shuntd/v1/explain` returns the full routing decision as JSON
with **no upstream call** — no tokens, no model load. Use it to verify
routing instead of generating completions.

Local smoke scripts live in `.scratch/` (not committed):
`audit-routing.js`, `probe-semantic.js`.

##  Milestones

M1 config chokepoint, M2 proxy and SSE, M3 tiers 1–2, M4 SQLite
decision log, M5 Tier 3 semantic — **all complete**.

**M6 (next): MVP / v1 release.** Cross-compile for four targets with
`--include` for the vram script; packaging *scaffolding* only (nfpm,
PKGBUILD, Homebrew formula templates — no maintained repos); a
`ServiceAdapter` registry (`LaunchdAdapter`, `SystemdAdapter`) behind
`shunt service install|uninstall|status`, which also persists the
Ollama env vars; a `docs/` directory; and pointing OpenClaw at shuntd.
Also queued: `packages/dashboard` (read-only over the log) and
`shunt audit` / `shunt clients`.

##  Settled decisions — do not relitigate

**Markdown parsing is `@lezer/markdown`**, not micromark. Chosen on
dependency weight: 3 transitive packages against 62. No math
extension, so `$$…$$` is an owned Regex+ pattern, and single-dollar
math is deliberately unsupported — currency appears in prompts far
more often than inline LaTeX.

**Owned regex uses Regex+ (`npm:regex`).** Four silent-failure traps,
documented at the top of `detect.js`: a literal space must be `\x20`
even inside a character class (`[ ]` compiles to `[]` and matches
nothing); inside a class escape `/ ) -`; outside a class `\-` is
invalid; `(?(DEFINE))` must come last.

**No NLP library.** Structural detectors are language-agnostic,
keyword triggers are user config, and multilingual intent falls out of
Tier 3 embeddings for free.

**Tags are routing preferences, not capability claims.** If two models
claim the same tag it stops differentiating. `qwen3-coder`
deliberately does NOT claim `TAG_MULTI_FILE` so devstral wins
multi-file prompts.

**Tag vocabulary lives in `packages/core/src/tags/index.js`** and is
validated in both directions at boot. It is the contract between the
extractor that emits tags and the catalog that claims them.

**Tier 2 ties break by** overlap score, then persona-default
preference, then name. Catalog key order must never affect routing.

**The embedder is bge-m3, selectable not pinned.** Named profiles
under `semantic.profiles`; threshold lives INSIDE each profile since
cosine calibration is model-specific. Vectors cached in SQLite keyed
by embedding model, so an A/B is a config line. `embedding_model` and
`embedding_dim` are stamped on every log row.

**A negative-class persona beats threshold tuning.** bge-m3 ranks well
and calibrates poorly, so absolute cosine scores are not comparable
across prompts. The `general` persona (no tags, unreachable from
Tier 2) gives off-topic prompts somewhere to land. **When a prompt
misroutes, add an exemplar matching that phrasing — do not lower the
threshold.** A missing exemplar looks exactly like a threshold set too
high. Validated: a CI prompt went 0.481 → 0.802 from one added
exemplar, threshold untouched.

**Exemplars differ by vocabulary, not adjective.** For short prompts
sentence SHAPE outweighs subject matter, so each persona needs nouns
the others never use. Cover both requests ("refactor this") and
symptoms ("the loop runs one too many times") — they occupy different
regions.

**Clients are identified by `User-Agent`, never by API key.**
Overloading a credential field with identity is an antipattern. App
headers win when present (`X-OpenWebUI-User-*`). Three columns stored
(`client_id`, `client_signature`, `user_agent`) so a mapping added
later applies retroactively.

**Everything is logged**, including bypass and raw passthrough, tiered
as `bypass` / `raw`. Excluding them made client mix and latency stats
silently wrong.

**Rejected and why:** Monk-Router-phi4mini (opaque hardware-aware
dispatcher — shuntd's own job); Jev / TypeSafe AI (hosted, unpublished
architecture, breaks local-first); `lil-marky` (8 months old, one
maintainer, no GFM tables, no position offsets); port-per-client
identification (too messy); FFI for NLP (build matrix).

##  Environment facts

Deno 2.9.6 stable on macOS and Arch.

Root `deno.json` has `"unstable": ["no-legacy-abort"]`. Without it
`Deno.serve` fires `request.signal` on *successful* responses, which
breaks abort propagation in `chat.js`.

`node:sqlite` is built in since Deno 2.2. `DatabaseSync` is
synchronous, which is why log writes are batched off the request path.

Ollama honours `stream_options: {include_usage: true}` on its
OpenAI-compatible endpoint, so token counts come free.

Ollama's `/v1/*` endpoints IGNORE per-request `options` (`num_ctx`)
and `keep_alive`; only `/api/*` accepts them. Per-persona context
sizing would need an optional Ollama capability layer. Deferred.

`launchctl setenv` does not survive a reboot — Ollama env vars have
been wiped twice by macOS updates. A LaunchAgent is the fix, and it is
M6 work.

Installed models: `gemma4:31b` (global default), `qwen3-coder-next`,
`devstral-small-2:24b`, `mistral-small3.2:24b`, `phi4-mini:latest`
(background tasks), `bge-m3:latest` (embedder — deliberately NOT in
the routing catalog, since a catalogued model is selectable as a chat
target and an embedder cannot serve a completion).

Open WebUI runs in OrbStack from `~/Docker/open-webui/compose.yml`,
version-pinned, with `ENABLE_OLLAMA_API=false` so all traffic goes
through shuntd, and Task Model set to `shuntd`.

##  Open questions — revisit with data, not intuition

A margin gate for Tier 3 (rejecting matches where the top two
personas are within a hair) is designed but not built. Wait until
logged traffic shows whether tight margins actually correlate with
misroutes.

Escalating *weak* Tier 2 matches to Tier 3 needs a notion of Tier 2
confidence that does not exist yet.

Threshold calibration from logged `confidence` values, bucketed by
whether the route was later overridden. That is why the column exists.
