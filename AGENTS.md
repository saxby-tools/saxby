#  shuntd

A local-first LLM routing daemon in a Deno/JSR monorepo. It sits in
front of an OpenAI-compatible backend, listens on `:11435` by default, and 
routes each request to the right local model. The goal is closing the gap to
a frontier-model experience on owned hardware, with a transparent
archive of every routing decision so the system gets tuned against
evidence rather than intuition.

> **How to read this file.** Everything above "Reference environment"
> is true for any checkout. That last section describes ONE working
> setup — specific models, a specific host OS, a specific UI. None of
> it is required, and none of it should be treated as a constraint on
> a contribution.

##  Packages

```
packages/core            shared contracts: tags, config, plist, root
packages/cli             `shunt` — config generation, vram-mac-guard
packages/llm-router      `shuntd` — the daemon
packages/vram-mac-guard  Apple Silicon VRAM ceiling LaunchDaemon
```

`vram-mac-guard` is platform-specific on purpose and names it. The
router is platform-agnostic and must stay that way.

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

Every tier that declines records a REASON. A silent fallback once made
a config bug look like correct behaviour for an entire milestone.

##  Working in this repo

Read the file before answering anything about it. Do not reconstruct
contents from an earlier turn — open it. If a fact can be checked with
a tool, check it. Most bugs in this project's history came from
confident assertion against a stale mental model: claiming a module
did not export something it did, leaving a renamed column in a view,
changing a function's signature without checking its other callers.

Never propose a commit for code that does not exist yet, and never
propose one that leaves the tree broken — files that cannot work
independently go in the same commit.

###  Code style

Hard 80-column limit. Generous vertical whitespace. One condition per
line. Modular if-guards rather than else chains. Constants at the top
of the file. Functions ordered by call order, never called before they
are defined. Filenames use dots, never underscores (`detect.test.js`).

###  Commands

```bash
deno task test                                    # unit tests
deno run -A packages/llm-router/src/main.js --trace
deno run -A packages/cli/src/main.js config generate
deno check packages/cli/src/main.js
```

`POST /shuntd/v1/explain` takes a `/v1/chat/completions` body and
returns the full routing decision as JSON with **no upstream call** —
no tokens, no model load. Use it to verify routing rather than
generating completions.

Tests are colocated (`*.test.js`), use fixture catalogs, and need no
daemon and no user config. Assertions naming real model ids belong in
a personal smoke script, not the suite — one machine's catalog is not
a project invariant.

##  Milestones

M1 config chokepoint, M2 proxy and SSE, M3 tiers 1–2, M4 SQLite
decision log, M5 Tier 3 semantic — **all complete**.

**M6 (next): MVP / v1 release.** Phased, in order. Instances first
(`getInstanceDir`, `--instance`, `shunt instance list`, the dev/prod
split, `shunt probe`), because everything after it assumes them.
Then cross-compilation for four targets with `--include` for the vram
script. Then a `ServiceAdapter` registry (`LaunchdAdapter`,
`SystemdAdapter`) behind `shunt service install|uninstall|status`,
which also persists backend environment variables. Then release
automation and packaging *scaffolding* (nfpm, PKGBUILD, Homebrew
templates — no maintained repos). Documentation last, since it
describes a surface that moves until the service work lands.

##  Decisions already made

These are settled with reasoning attached. Changing one is fine — but
bring evidence against the reasoning, not a preference.

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
claim the same tag it stops differentiating, so a model that is
*capable* of something should not claim the tag unless it is the one
that work should reach.

**`TAG_VISION` and `TAG_AUDIO` are REQUIREMENTS, not preferences.**
They filter the candidate set rather than contributing to a score — a
model that cannot see is not a worse choice for an image prompt, it is
a broken one. They are separate tags because a model may do one and
not the other. This is the second concept in the tag vocabulary and
the one most likely to be mistaken for the first.

**Tag vocabulary lives in `packages/core/src/tags/index.js`** and is
validated in both directions at boot. It is the contract between the
extractor that emits tags and the catalog that claims them.

**Multimodal `content` arrives as an ARRAY of parts**, not a string.
It must be normalised before anything reads it — collapsing it with
`String()` yields `"[object Object]"`, which then gets
feature-extracted, embedded and logged as if it were the prompt.

**Intent comes from the last user message; weight comes from the whole
payload.** Two different jobs, conflated once already. An agent sends
twenty messages and a two-line question — estimating from the question
alone was wrong by three orders of magnitude and silently disabled the
context-fit check.

**Tier 2 ties break by** overlap score, then persona-default
preference, then name. Catalog key order must never affect routing.

**The embedder is selectable, not pinned.** Named profiles under
`semantic.profiles`; threshold lives INSIDE each profile since cosine
calibration is model-specific. Vectors are cached in SQLite keyed by
embedding model, so an A/B is a config line rather than a re-embed.
`embedding_model` and `embedding_dim` are stamped on every log row.

**The embedder is injectable** on the semantic context, so Tier 3 is
unit-testable without a network call.

**An embedding model must never be in the routing catalog.** A
catalogued model is selectable as a chat target, and an embedder
cannot serve a completion.

**A negative-class persona beats threshold tuning.** Retrieval
embedders rank well and calibrate poorly, so absolute cosine scores
are not comparable across prompts. A `general` persona (no tags, so
unreachable from Tier 2) gives off-topic prompts somewhere to land.
**When a prompt misroutes, add an exemplar matching that phrasing — do
not lower the threshold.** A missing exemplar looks exactly like a
threshold set too high, and lowering it widens every persona at once.

**Exemplars differ by vocabulary, not adjective.** For short prompts
sentence SHAPE outweighs subject matter, so each persona needs nouns
the others never use. Cover both requests ("refactor this") and
symptoms ("the loop runs one too many times") — they occupy different
regions of the vector space.

**Clients are identified by `User-Agent`, never by API key.**
Overloading a credential field with identity is an antipattern.
App-specific headers win when present. Three columns are stored
(`client_id`, `client_signature`, `user_agent`) so a name mapping
added later applies retroactively.

**Everything is logged**, including bypass and raw passthrough, tiered
as `bypass` / `raw`. Excluding them made client mix and latency stats
silently wrong while looking complete.

**Observability is never load-bearing.** A failed log write, a missing
embedder, or an unreachable decision log degrades the feature and
leaves routing working.

**Instances isolate config, archive and vectors together.** A named
instance resolves to `instances/<name>/` under the config root; no
name resolves to the root itself, so existing installs need no
migration. Isolation is total rather than partial because the
decision log is the point: dev traffic landing beside production rows
would quietly corrupt the data that threshold calibration and
exemplar tuning depend on. The useful consequence is that an A/B
between embedders becomes two files to compare rather than one file
to filter.

**Development runs on a non-default port, production keeps `:11435`.**
Clients point at a port and stay pointed there, so the stable thing
gets the stable address. Moving production would mean either dev gets
no client traffic — testing nothing the split was meant to help with
— or repointing clients on every run.

**Service labels use the `org.shuntd` prefix**, from the project's
domain. Default instance bare, named instances suffixed:
`org.shuntd.router`, `org.shuntd.router.dev`; on Linux
`shuntd.service`, `shuntd-dev.service`. The VRAM guard is
`org.shuntd.vram-mac-guard`, one name for package, command, script and
label. The prefix is one constant in `@shuntd/core`.

**Installed files live under `/usr/local`, not `/etc`.** The guard's
script goes to `/usr/local/libexec/shuntd/` and its optional override
file to `/usr/local/etc/shuntd/vram-mac-guard.env` — the FHS split
between program and config, with `/etc` left to the OS. The script
sources that file AS ROOT, so it refuses a file that root does not own
or that anyone else can write; `/usr/local` is user-writable on some
Homebrew setups. Uninstall leaves the config, as pacman does.

**The config schema and loader live in `@shuntd/core`.** The config
file is a contract between packages: `shunt config generate` writes
it, the daemon reads it, `shunt probe` and `shunt instance list` read
it. A CLI importing the daemon's internals would point the dependency
the wrong way.

**License is AGPL-3.0-or-later.** shuntd is a network service, and
plain GPL never triggers for software that is only run, not
distributed.

**One version for every package**, bumped together in the release
commit. The first tag is `v1.0.0`.

**Rejected and why:** a hosted router model (opaque dispatcher —
shuntd's own job); a hosted typed-classification API (unpublished
architecture, breaks local-first); `lil-marky` (young, single
maintainer, no GFM tables, no position offsets); port-per-client
identification (multiplies config); FFI for NLP (per-platform build
matrix, against the portability story).

##  Ecosystem facts

True regardless of whose machine this runs on.

Deno 2.9+. `node:sqlite` is built in since 2.2. `DatabaseSync` is
synchronous, which is why log writes are batched off the request path.

Root `deno.json` sets `"unstable": ["no-legacy-abort"]`. Without it
`Deno.serve` fires `request.signal` on *successful* responses, which
breaks abort propagation in `chat.js`.

Ollama honours `stream_options: {include_usage: true}` on its
OpenAI-compatible endpoint, so token counts come free.

Ollama's `/v1/*` endpoints IGNORE per-request `options` (`num_ctx`)
and `keep_alive`; only `/api/*` accepts them. Per-persona context
sizing would need an optional Ollama capability layer. Deferred.

`OLLAMA_MAX_LOADED_MODELS` is a ceiling, not a reservation — models
load concurrently only if they also fit in available memory.

On macOS, `launchctl setenv` does not survive a reboot. Persisting
backend environment variables needs a LaunchAgent, which is M6 work.

##  Open questions — revisit with data, not intuition

A margin gate for Tier 3 (rejecting matches where the top two
personas are within a hair) is designed but not built. Wait until
logged traffic shows whether tight margins actually correlate with
misroutes.

Escalating *weak* Tier 2 matches to Tier 3 needs a notion of Tier 2
confidence that does not exist yet.

Threshold calibration from logged `confidence` values, bucketed by
whether the route was later overridden. That is why the column exists.

Override capture — nothing currently records "the router chose X and
the user forced Y." It is the highest-value missing signal, because it
is the only ground truth the system can collect about itself.

##  Post-v1 backlog

Not scheduled. Grouped by what unlocks what.

**Blocked on logged traffic:** threshold calibration; the Tier 3
margin gate; Tier 2 confidence; override capture.

**Routing:** image and audio token weight in `est_tokens` (counted,
not charged); cache-aware routing, since alternating models discards a
warm prefix cache; tool-call request shape detection; `//CLOUD`
fallback with credential substitution; per-model `system_prefix`.

**Infrastructure:** `packages/dashboard` (read-only, Evidence.dev);
first-class `/v1/embeddings` route so embedding traffic is logged;
semantic search over the prompt archive (prompts are already
embedded); hot reload of `$XDG_CONFIG_HOME/shuntd`; middleware hooks
for response transforms; per-persona `num_ctx` via the Ollama-native
capability layer; a multilingual extractor, which the canonical tag
vocabulary was designed to accept as a drop-in.

**Discovery and UX:** user-defined custom tags, so specialised fields
can adapt personas without forking; model capability auto-discovery
for *measurable* facts only (context, params, quant) with capability
tags staying curated; optional-dependency presets for third-party
SQLite viewers, delegating rather than vendoring; a hardware analyser
and recommender; leaderboard ingestion at design time only, never in
the hot path.

---

##  Reference environment

**This section describes the maintainer's setup. It is not a
requirement and not a constraint on contributions.** It is here
because several decisions above were validated against it, and
knowing the shape of that validation is useful context.

Apple Silicon, 128 GB unified memory, with the VRAM ceiling raised to
roughly 112 GB by `vram-mac-guard`. A second machine runs Arch Linux.

Backend is Ollama. Catalog: a 31B multimodal generalist as the global
default, a long-context coder, a multi-file coding specialist, a
24B multimodal generalist, a 3.8B model for background tasks, and
`bge-m3` as the embedder — deliberately outside the routing catalog.

Open WebUI runs in a container with `ENABLE_OLLAMA_API=false`, so all
of its traffic goes through shuntd, and its Task Model is set to
`shuntd` so background generation is routed and logged rather than
bypassing. OpenClaw is configured as an OpenAI-compatible provider
pointed at `:11435`.

Numbers quoted in the decisions above come from this setup. The
exemplar-versus-threshold finding, for instance, is one prompt moving
from 0.481 to 0.802 after a single added exemplar with the threshold
untouched — real evidence, but from one catalog with one embedder.
Expect different absolute numbers elsewhere; the reasoning should
still hold.
