#  Saxby

A local-first LLM routing daemon in a Deno/JSR monorepo. It sits in
front of an OpenAI-compatible backend, listens on `:11435` by default, and 
routes each request to the right local model. The goal is closing the gap to
a frontier-model experience on owned hardware, with a transparent
archive of every routing decision so the system gets tuned against
evidence rather than intuition.

Saxby was called shuntd through v0.9.3, with a CLI named `shunt`.
Those releases, and older issues and discussions, still use the old
names. The rename was a clean break: no aliases, no fallbacks, no
migration.

> **How to read this file.** Everything above "Reference environment"
> is true for any checkout. That last section describes ONE working
> setup — specific models, a specific host OS, a specific UI. None of
> it is required, and none of it should be treated as a constraint on
> a contribution.

##  Packages

```
packages/core            shared contracts: tags, config, plist, root,
                         backend adapters, memory probes
packages/cli             `saxby` — config generation, vram-guard-mac,
                         reserve
packages/llm-router      `saxbyd` — the daemon
packages/vram-guard-mac  Apple Silicon VRAM ceiling LaunchDaemon
```

`vram-guard-mac` is platform-specific on purpose and names it. The
router is platform-agnostic and must stay that way.

The guard changes a macOS-only setting while the machine runs, so it
has no Linux twin. On Linux what matters is the memory design, not
the GPU vendor. A GPU card's memory is fixed, with no ceiling to
raise. AMD's shared-memory chips, such as Strix Halo, set the GPU's
share with kernel parameters at boot, which is a docs recipe, not a
daemon. The platform goes last in the name so a sibling, if one ever
appears, sorts beside it.

##  Routing tiers

| Tier | Mechanism | Resolves to |
| ---- | --------- | ----------- |
| 1 | `/coder`, `saxby/<model>` bypass, raw model name | exactly what was asked |
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

`POST /saxby/v1/explain` takes a `/v1/chat/completions` body and
returns the full routing decision as JSON with **no upstream call** —
no tokens, no model load. Use it to verify routing rather than
generating completions.

`GET /saxby/v1/reservations` shows the memory broker's budget, also
without loading anything. Test the broker with tiny reservations and
harmless children (`saxby -i dev reserve --gib 1 -- sleep 5`), never a
real GPU job.

Tests are colocated (`*.test.js`), use fixture catalogs, and need no
daemon and no user config. Assertions naming real model ids belong in
a personal smoke script, not the suite — one machine's catalog is not
a project invariant.

##  Milestones

M1 config chokepoint, M2 proxy and SSE, M3 tiers 1–2, M4 SQLite
decision log, M5 Tier 3 semantic — **all complete**.

**M6: MVP / v1 release** — Phases 0–3, the Phase 4 docs, the rename
(v0.9.4), packaging and publishing (v0.9.5), the memory broker
(v0.9.6), the decision log privacy release (v0.9.7) and tailnet
clients (v0.9.8) are done. What remains is one GitHub milestone each:
the JSDoc sweep (v0.9.9), then the v1.0.0 tag
([Roadmap](docs/roadmap.md)).
Phased, in order. Instances first
(`getInstanceDir`, `--instance`, `saxby instance list`, the dev
instance, `saxby probe`), because everything after it assumes them.
Then cross-compilation for four targets with `--include` for the vram
script. Then a `ServiceAdapter` registry (`LaunchdAdapter`,
`SystemdAdapter`) behind `saxby service
install|uninstall|status|restart`. Then release
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
documented at the top of
[`detect.js`](packages/llm-router/src/pipeline/detect.js): a literal
space must be `\x20` even inside a character class (`[ ]` compiles to
`[]` and matches nothing); inside a class escape `/ ) -`; outside a
class `\-` is invalid; `(?(DEFINE))` must come last.

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
the one most likely to be mistaken for the first. Because they are
facts, `config generate` takes them from what the backend reports,
never from the model's name: the curated "gemma" pattern once gave
TAG_AUDIO to gemma4:31b, which has no audio encoder.

**Tag vocabulary lives in
[`packages/core/src/tags/index.js`](packages/core/src/tags/index.js)**
and is validated in both directions at boot. It is the contract between
the extractor that emits tags and the catalog that claims them.

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

**The decision log stores no user text unless asked.** It is a plain
SQLite file; `node:sqlite` can neither password-protect nor encrypt
it, and encryption at rest would not protect users from the operator,
who holds the key. Storing less is the fix. `log_prompts` defaults to
`false`; opt-out logging is reserved for a future server-backed store
with its own access control. **Detector evidence is never user
text**: counts, booleans and names from a fixed vocabulary. Through
v0.9.6 `filePaths` stored the first ten paths it found, which name
users, clients and projects, with routing reading only the count. The
prompt hash is an HMAC with a per-instance key in `prompt-hash.key`,
so a shared log cannot be checked against guesses and no table of
common prompts matches every install; the key sits beside the log, so
it does not protect a stolen folder. Every row names its scheme in
`prompt_hash_scheme`. Files are owner-only and `secure_delete` is on.
Trails left by other tools (Open WebUI, OpenClaw) get a paragraph in
[Clients](docs/clients.md), nothing more: Saxby fixes its own part of
the stack.

**Observability is never load-bearing.** A failed log write, a missing
embedder, or an unreachable decision log degrades the feature and
leaves routing working.

**Instances isolate config, archive and vectors together.** A named
instance resolves to `instances/<name>/` under the config root; no
name resolves to the root itself, so existing installs need no
migration. Isolation is total rather than partial because the decision
log is the point: the dev instance's traffic landing beside the
default instance's rows would quietly corrupt the data that threshold
calibration and exemplar tuning depend on. The useful consequence is
that an A/B between embedders becomes two files to compare rather than
one file to filter.

**The dev instance runs on a non-default port; the default instance
keeps `:11435`.** Clients point at a port and stay pointed there, so
the stable thing gets the stable address. Moving the default instance
would mean either the dev instance gets no client traffic — testing
nothing the split was meant to help with — or repointing clients on
every run.

**Names follow one model.** The brand, the CLI and the model ID
clients ask for are `saxby`; the daemon's binary is `saxbyd`, the same
split as `tailscale` and `tailscaled`. Any other name applies that
ecosystem's convention to this model: packages are named for the
project and ship both binaries, the AUR adds `-bin` because the
packages are prebuilt, and systemd units are named for the binary.
Env vars use `SAXBY_`, JSR packages `@saxby/<pkg>`, the HTTP namespace
`/saxby/v1/*`.

**Service labels use the `tools.saxby` prefix**, reverse-DNS from
`saxby.tools`. Default instance bare, named instances suffixed:
`tools.saxby.router`, `tools.saxby.router.dev`; on Linux
`saxbyd.service`, `saxbyd-dev.service`. The VRAM guard is
`tools.saxby.vram-guard-mac`, one name for package, command, script and
label. The prefix is one constant in `@saxby/core`.

**Installed files live under `/usr/local`, not `/etc`.** The guard's
script goes to `/usr/local/libexec/saxby/` and its optional override
file to `/usr/local/etc/saxby/vram-guard-mac.env` — the FHS split
between program and config, with `/etc` left to the OS. The script
sources that file AS ROOT, so it refuses a file that root does not own
or that anyone else can write; `/usr/local` is user-writable on some
Homebrew setups. Uninstall leaves the config, as pacman does.

**The guard sets the ceiling once, at boot, and reads no backend
state.** Through v0.9.5 it polled `ollama ps` and dropped the ceiling to
75% of RAM whenever nothing was loaded. Backends read the ceiling once,
at startup, and nothing is loaded at startup, so Ollama always saw the
low value and evicted models the raised ceiling had room for. Lowering
it frees nothing: the ceiling is a maximum, not a reservation. A
LaunchDaemon runs before login, so a backend started by a login agent
reads the raised value with no restart. Knowing no backend also keeps
the guard out of any adapter work.

**The config schema and loader live in `@saxby/core`.** The config
file is a contract between packages: `saxby config generate` writes
it, the daemon reads it, `saxby probe` and `saxby instance list` read
it. A CLI importing the daemon's internals would point the dependency
the wrong way.

**A saved config is applied live, whole or not at all.** saxbyd
watches the instance folder and reloads the config on a save
([`config/reload.js`](packages/llm-router/src/config/reload.js)). The
new config is validated and given its Tier 3 vectors off to the side,
then swapped in with one assignment. It is replaced, never edited, so
a request in flight keeps the config it started with. A file that
cannot be applied leaves the old config serving, and the reason is
printed AND kept on `/saxby/v1/status` for `saxby status` to show:
whoever saved the file is looking at an editor, not at the log, and a
declined edit nobody hears about is the silent fallback again.
`listen_host`, `listen_port`, `log_path` and `memory` need a restart,
and an edit that touches one is declined whole, not half applied, so
the running config is always exactly one version of the file.
`memory` is on that list because the broker's sweep timer and
heartbeat interval are tied to jobs already holding reservations;
pins and sizes do reload, since the budget is worked out fresh at
each decision, and the ledger is never touched. **A reload never
turns off a working Tier 3**: if the embedder cannot embed a new
exemplar, the edit is declined. The guard lists reload too, with the
lines a boot prints, because whoever can write the file is already a
local program. The API token stays boot-only. The FOLDER is watched,
not the file, since editors save by rename and the decision log's
writes in the same folder are filtered out by name. A symlinked
config is watched in the real file's folder as well. The save is the
only trigger: no signal and no route, until something shows the
watch is not enough. Checked on macOS, and in a container on a named
volume and on a bind mount from a Mac (Nov. 9, 2026).

**License is AGPL-3.0-or-later.** Saxby is a network service, and
plain GPL never triggers for software that is only run, not
distributed.

**Saxby does not manage the backend's environment.** Ollama runs
under its own supervisor — `brew services`, Ollama.app, or a system
unit on Linux that a `systemd --user` service cannot reach. Whatever
starts the backend owns its environment; Saxby setting it would be a
second opinion that sometimes loses a race. `docs/` carries a recipe
per platform instead.

**One version for every package**, bumped together in the release
commit. `v0.9.0` is a pre-release that proves the release path and
gives the packages real artifacts; `v1.0.0` follows when the
`v1.0.0` milestone on GitHub is empty. Any `v0.*` or `-suffixed` tag
is published as a pre-release.

**Packages are published, boring, and automated.** Shipping packaging
templates nobody submits looks worse than shipping none, so the
release workflow publishes binary packages itself: a Homebrew tap
(`saxby-tools/homebrew-tap`), `saxby-bin` on the AUR, and JSR. This
reverses the M6 plan's "scaffolding only, no maintained repos"; the
reason that plan gave — a maintained package is a per-release
promise — is met by making every release update them with no manual
step. **Support happens on GitHub issues only.** Package pages point
there; nobody monitors AUR or Homebrew comment threads. If Saxby
grows, others can maintain fancier packages or forks.

**Saxby asks nothing of this machine and a token of every other.**
It listens on `127.0.0.1` unless `listen_host` says otherwise —
`Deno.serve` with no hostname listens on every interface, and until
v0.9.2 that put Saxby, and through its catch-all Ollama's management
API, on the LAN. v0.9.2 refused every other bind. The Docker image
made that a config field: a container's loopback is unreachable from
outside it, so a refusal meant no image. A wider bind is the
operator's call, named at every boot rather than refused — their
machine, their decision; what protects it is the API token (next
entry), not the warning. A guard
([`security/guard.js`](packages/llm-router/src/security/guard.js)) runs
before every route and refuses forwarding headers (a proxy on the same
box makes strangers look local; the one exception is two entries
down), any `Origin` not listed in `allowed_origins` (a browser), a
`Host` that is neither a local name nor in `allowed_hosts` (DNS
rebinding; a browser cannot forge `Host`, so a listed name loosens
nothing) and Ollama's management paths. It judges "browser" by
`Origin` and `Host` only: Node's `fetch` sends `sec-fetch-mode: cors`
from server code, and OpenClaw's real requests carry it.
`host.docker.internal` is allowed because a Docker Desktop container
reaches the host by that name; a Compose service name goes in
`allowed_hosts`. What remains of the post-v1 exposure work is
per-client keys and proxies other than Tailscale Serve; when keys
land, "identified by `User-Agent`, never by API key" must be
revisited, since its objection is to keys nobody verifies.

**One shared API token, for any request not straight from this
machine.** "Straight from this machine" is a loopback connection with
no forwarding header; everything else — through a trusted proxy, or
over a listener that is not loopback, which is every client of a
container — must send the token.
One rule, so no second kind of exposure can arrive without it. Local
clients need nothing, which keeps every existing install working.
The token is checked BEFORE any other proxied check, so a caller
without it learns nothing about the config. It lives in `api-token`
beside the config, never in `config.jsonc`, which gets pasted into
issues; saxbyd writes a random one at first boot and reads it at
boot only. The operator may write their own, and a short one is
warned about at every boot, not refused — nudged, not blocked. If the
file cannot be read, other machines are refused and local clients
are served: fail closed for strangers, never for the router. Saxby's
own token is never forwarded to the backend. It is ONE token, so it
identifies nobody, and "clients are identified by `User-Agent`"
stands untouched. **The token lets a caller in; it does not make it
a local program.** Whatever is not straight from this machine gets
chat and the model list, never the broker or the catch-all, plus the
status route for a direct connection, which is `saxby` asking a
daemon bound to one interface. **Loopback is the whole definition of
local, so a TCP-level forwarder defeats all of it**: `ssh -L`, `socat`
and `tailscale serve --tcp` add no header, and what they carry looks
local. Docker Desktop is one too: a container that calls
`host.docker.internal` arrives on the host's loopback, so it needs
no token and reaches the broker (checked Nov. 9, 2026, on macOS).
That was true before the token and is documented, not solved.

**One proxy may be trusted: Tailscale Serve, named in
`trusted_proxies`.** Off by default, added in v0.9.8 so a phone
keyboard on the tailnet could reach Saxby with no agent in between.
Every proxied request must carry the API token (previous entry);
v0.9.8 was built without one, and #49 closed that. Per-client keys
stay post-v1. Beyond the token, the guard checks that a proxied
request fits Serve and nothing else: a
loopback connection, the configured `Host`, only the three forwarding
headers Serve sends, one tailnet address in `X-Forwarded-For`, no
Funnel header, no `Origin`. Serve deletes a client's own
`Tailscale-User-*` and Funnel headers and overwrites
`X-Forwarded-For` (`ipn/ipnlocal/serve.go`, v1.102.2), so a tailnet
device cannot fake them. **A header cannot prove which proxy sent
it**: every connection is from 127.0.0.1, and a program on this
machine can send the same headers — but it could already call Saxby
directly, and it is why the token exists. Proxied requests reach chat
and the model list ONLY, never the memory broker, status, explain or
the catch-all. The log does not yet say who called through the proxy
(#50), because a login names a person and `log/client.js` stores apps.

**One kind of browser client may be let in: an extension, by its
exact origin in `allowed_origins`.** Off by default. A browser sets
`Origin` itself, so a web page cannot claim an extension's, and that
is the whole basis for trusting the header. No wildcards:
`chrome-extension://*`, which extension READMEs tell Ollama users to
set in `OLLAMA_ORIGINS`, lets in every extension in the browser. No
web-page
origins: a page would also need CORS answers, and a guard that passes
a request whose response the page cannot read has only let the side
effects through. An allowed extension gets the same two routes as a
proxied client. Because every extension sends the browser's
`User-Agent`, its client signature is its id, `ext-<id>` — the one
place identity comes from a header other than `User-Agent` or an app
header, and still never from a credential.

**A request field a client cannot send comes from `client_defaults`,
keyed by client signature.** One field, one value:
`reasoning_effort: "none"`, the only value safe on every model (see
Ecosystem facts). Per client rather than per model, because the
default model also serves chat and code. Per client rather than per
persona, because a persona route would hinge on Tier 3 recognising
the client's template every time, and one miss brings back a
13-second answer with nothing to show why; the `User-Agent` is known
on every request. The request's own value always wins, and what Saxby
added is stored on the row.

**The memory broker lives in Saxby, and fails closed.** On Oct. 27,
2026, an uncapped PyTorch job grew to 122 GiB beside two loaded models
and the kernel panicked ([Memory broker](docs/memory-broker.md)).
`saxby reserve --gib N -- <command>` asks saxbyd for N before the job
starts. It lives in Saxby because Ollama sizes a load from the memory
it sees free, and a reservation not yet used looks free: only
something in front of the loads can make them wait, and Saxby already
proxies them. vram-guard-mac stays a boot-time script that reads no
backend state. One formula judges jobs and loads: `ceiling − margin −
pinned − loaded − reserved`, with pinned models counted at full size
loaded or not, and every other loaded model counted because a job
cannot evict it. Any unknown term admits nothing. If saxbyd can't be
asked, the job does not run: no answer from the broker is never a
yes. `--no-broker` runs anyway, loudly. The gate runs only while a job
holds a reservation, chat and catch-all alike; with none, the chat
route only notes the load in the ledger, synchronously, so the fast
path never awaits.
The gate is load-bearing; its log rows are not.

**saxbyd may start exactly `kill`, `sysctl` and `vm_stat`, by absolute
path.** It used to start nothing, so a bug in request handling could
launch no program. The broker needs `kill -0` so that a job whose
wrapper was force-killed stays counted until the job itself exits —
the panic above is the case — plus `sysctl` and `vm_stat` to read the
ceiling and wired memory. `Deno.kill(pid, 0)` would need unrestricted
`--allow-run`, which is why a program list is used instead. Absolute
paths, so a changed PATH can't swap one out; Linux needs only `kill`.
**The list is closed**: adding a program needs a stated reason here.
It lives in `SAXBYD_RUN` in [`scripts/build.js`](scripts/build.js),
and `deno task dev` takes the same flags.

**The Docker image is the release's own binaries on a bare base, and
every client of it needs the token.** `saxbytools/saxby` is
distroless `cc`, because Deno-compiled binaries need glibc and libgcc
and nothing else; it runs as `nonroot`, with one volume at `/data`
and `XDG_CONFIG_HOME=/data`, since config, log, vectors and token are
one tree. The workflow copies the release's Linux tarballs in rather
than compiling a fifth time, so the image and the tarball hold the
same bytes. In a container saxbyd binds `0.0.0.0` by config, never by
an env var or a second build of the binary. The container's own
loopback is the only thing local to it, so the host through a
published port and the next container over both send the token; that
is the right default where `-p 11435:11435` reaches every interface.
Tags are `X.Y.Z` and `X.Y`, with no `latest` before v1.0.0, since
every v0.* release is a pre-release. Signed by digest with cosign,
keyless. The memory broker stays a feature of a native install: in a
container it cannot see the host's processes, so it fails closed and
says why.

**Rejected and why:** a hosted router model (opaque dispatcher —
Saxby's own job); a hosted typed-classification API (unpublished
architecture, breaks local-first); `lil-marky` (young, single
maintainer, no GFM tables, no position offsets); port-per-client
identification (multiplies config); FFI for NLP (per-platform build
matrix, against the portability story).

##  Ecosystem facts

True regardless of whose machine this runs on.

Deno 2.9+. `node:sqlite` is built in since 2.2. `DatabaseSync` is
synchronous, which is why log writes are batched off the request path.

Root [`deno.json`](deno.json) sets `"unstable": ["no-legacy-abort"]` so
that `request.signal` fires only on a real client disconnect. Without it
the signal ALSO fires after a response is fully delivered.
`deno compile` ignores the setting, and the explicit flag too, so
compiled binaries run legacy semantics. In
[`chat.js`](packages/llm-router/src/routes/v1/chat.js) the late abort
lands after the upstream stream has ended and changes nothing — checked
end to end on Deno 2.9.6, see [Releasing](docs/releasing.md). Code that
reads the signal must stay correct under both semantics.

Ollama honours `stream_options: {include_usage: true}` on its
OpenAI-compatible endpoint, so token counts come free.

Ollama's `/v1/*` endpoints IGNORE per-request `options` (`num_ctx`)
and `keep_alive`; only `/api/*` accepts them. Per-persona context
sizing would need an optional Ollama capability layer. Deferred.

Ollama's `/v1/chat/completions` honours `reasoning_effort`. `"none"`
turns reasoning off and is accepted by every model; any other value
gets a 400, "does not support thinking", from a model with no
reasoning. `think: false` is IGNORED on `/v1` — the model reasons
anyway. Checked on 0.40.15 with a 31B reasoning model and a 3B model
without.

`OLLAMA_MAX_LOADED_MODELS` is a ceiling, not a reservation — models
load concurrently only if they also fit in available memory.

Ollama has no API that reports the GPU's total memory; `total=` exists
only in its log. `/api/ps` reports each loaded model's `size_vram`.

On Apple Silicon, `iogpu.wired_limit_mb`, when above 0, equals Metal's
`recommendedMaxWorkingSetSize`: 98,304 MiB read as 103,079,215,104
bytes on an M5 Max. When it is 0, only Metal knows the default.

PyTorch's MPS cap is `PYTORCH_MPS_HIGH_WATERMARK_RATIO` times
`recommendedMaxWorkingSetSize`, default 1.7, which is no cap on
unified memory. A ratio of 0 DISABLES it. The low watermark, default
1.4, may not exceed the high one, so setting only the high one below
1.4 makes PyTorch fail at startup. Set both.

`Deno.kill(pid, 0)` needs unrestricted `--allow-run`; a list such as
`--allow-run=/bin/kill` is not enough (Deno 2.9.8). `deno compile`
with such a list still lets the binary run each listed program.

On macOS, `launchctl setenv` does not survive a reboot, and a
LaunchAgent that re-runs it at login races the backend's own agent —
login items start in no fixed order. The reliable place for a
backend's environment is the supervisor that starts it.

##  Open questions — revisit with data, not intuition

Each question below is also a public Discussion, where the human
side of the conversation happens: margin gate #14, Tier 2 confidence
#15, threshold calibration #16, override capture #17. Known gaps —
untested paths, hotfixes that left something behind — are issues
labelled `known-gap`. Every gap found during work gets one; nothing
stays as an undocumented TODO.

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

Not scheduled. Grouped by what unlocks what. Discussed publicly as
routing #18, infrastructure #19, and discovery and UX #20.

**Blocked on logged traffic:** threshold calibration; the Tier 3
margin gate; Tier 2 confidence; override capture.

**Routing:** image and audio token weight in `est_tokens` (counted,
not charged); cache-aware routing, since alternating models discards a
warm prefix cache; tool-call request shape detection; `//CLOUD`
fallback with credential substitution.

**Infrastructure:** `packages/dashboard` (read-only, Evidence.dev);
first-class `/v1/embeddings` route so embedding traffic is logged;
semantic search over the prompt archive (prompts are already
embedded); middleware hooks for response transforms; per-persona
`num_ctx` via the Ollama-native capability layer; a multilingual
extractor, which the canonical tag vocabulary was designed to accept
as a drop-in.

**Discovery and UX:** user-defined custom tags, so specialised fields
can adapt personas without forking; model capability auto-discovery
for *measurable* facts only (params, quant; context length and
TAG_VISION / TAG_AUDIO are already discovered), with preference tags
staying curated; optional-dependency presets for third-party
SQLite viewers, delegating rather than vendoring; a hardware analyser
and recommender; leaderboard ingestion at design time only, never in
the hot path.

---

##  Reference environment

**This section describes the maintainer's setup. It is not a
requirement and not a constraint on contributions.** It is here
because several decisions above were validated against it, and
knowing the shape of that validation is useful context.

Apple Silicon (M5 Max), 128 GB unified memory, macOS 26. The GPU
wired ceiling is LOWERED to 96 GiB by `vram-guard-mac`'s override
file, below macOS's own default of 107.5 GiB on this machine. An
uncapped GPU job once wired 123.7 GiB and the kernel panicked; the
lower ceiling keeps 32 GiB the GPU can never take. A second machine
runs Arch Linux.

Backend is Ollama. Catalog: a 31B multimodal generalist as the global
default and interim coder, a 27B coder kept out of routing until it
clears a security test, a 3B model for background tasks, a 3B audio
model, and `bge-m3` as the embedder — deliberately outside the
routing catalog.

Open WebUI runs in a container with `ENABLE_OLLAMA_API=false`, so all
of its traffic goes through Saxby, and its Task Model is set to
`saxby` so background generation is routed and logged rather than
bypassing. OpenClaw is configured as an OpenAI-compatible provider
pointed at `:11435`.

Numbers quoted in the decisions above come from this setup. The
exemplar-versus-threshold finding, for instance, is one prompt moving
from 0.481 to 0.802 after a single added exemplar with the threshold
untouched — real evidence, but from one catalog with one embedder.
Expect different absolute numbers elsewhere; the reasoning should
still hold.
