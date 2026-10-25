#  Architecture

How Saxby is put together, for anyone changing it. The reasoning
behind each decision lives in [`AGENTS.md`](../AGENTS.md); this page is the map.

##  Packages

```
packages/core            shared contracts: tags, config, instances,
                         service naming, the status probe
packages/llm-router      saxbyd — the daemon
packages/cli             saxby — config, instances, services, probe
packages/vram-guard-mac  Apple Silicon VRAM ceiling LaunchDaemon
```

Everything depends on `core`; nothing depends on `llm-router`. The
config file is a contract between the CLI that writes it and the
daemon that reads it, so its schema and loader live in `core` rather
than in either side. The same goes for the tag vocabulary, which the
extractor emits and the catalog claims.

`vram-guard-mac` is macOS-only on purpose and says so in its name.
Everything else is platform-agnostic.

The build makes two binaries: `saxbyd` from `llm-router`, and `saxby`
from `cli`, which includes the guard's shell script.

##  Boot

[`packages/llm-router/src/main.js`](../packages/llm-router/src/main.js),
in order:

1. **Instance.** `--instance`, then `SAXBY_INSTANCE`, then the
   default. This fixes which folder everything else comes from.
2. **Config.** Load and validate. Any problem stops the boot here,
   naming the file.
3. **Tag contract.** Warn about claimed tags that can never match.
4. **Decision log.** Open the SQLite file and apply migrations. A
   failure here costs logging, not routing.
5. **Tier 3.** Check the embedder answers, then embed any exemplars
   not already cached and prune stale ones. A failure here costs
   Tier 3, not routing.
6. **Serve.** Listen on `127.0.0.1` only, never other interfaces.
   Saxby checks no credentials, so nothing beyond this machine may
   reach it until per-client keys exist. A port clash is explained by
   asking the holder who it is.

Steps 4 and 5 can fail without stopping Saxby. Observability and
cleverness are optional; routing is not.

##  The guard

Before any route — chat, `explain`, `status`, the catch-all — every
request passes
[`security/guard.js`](../packages/llm-router/src/security/guard.js). It
refuses, with a 403 and a log line, anything that is not a local,
non-browser client:

- **forwarding headers** (`X-Forwarded-*`, `Forwarded`, `Via` and
  similar): a proxy on this machine makes strangers look local;
- **any `Origin` header**: a web page in a browser;
- **a `Host` that is not a local name**: DNS rebinding;
- **Ollama's management paths** (`/api/pull`, `push`, `create`,
  `copy`, `delete`, `blobs`): nothing needs them through a router.

It decides "browser" by `Origin` and `Host` only, never `Sec-Fetch-*`,
which Node's own `fetch` sends from server code.

##  A routed request

`POST /v1/chat/completions` with `model: "saxby"`, in
[`routes/v1/chat.js`](../packages/llm-router/src/routes/v1/chat.js),
once the guard has let it through:

1. **Identify the client** from app headers or the `User-Agent`
   ([`log/client.js`](../packages/llm-router/src/log/client.js)).
2. **Extract intent**
   ([`pipeline/extract.js`](../packages/llm-router/src/pipeline/extract.js)).
   Intent comes from the last user message; weight comes from the whole
   payload. Image and audio parts are counted, never stringified.
3. **Resolve**
   ([`pipeline/resolve.js`](../packages/llm-router/src/pipeline/resolve.js)).
   Tiers 1 and 2 are synchronous and cost microseconds. Tier 3 makes one
   embedding call, so it runs only when both abstain. Every tier that
   declines records why.
4. **Select.** The first candidate whose context window fits wins.
   Requests nothing can serve are refused with a 400 here, without
   touching the backend.
5. **Record.** The decision is queued for the log.
6. **Proxy.** The request goes upstream with only `Content-Type` and
   `Authorization`, asking the backend to report token usage.
7. **Observe**
   ([`observability/stream.js`](../packages/llm-router/src/observability/stream.js)).
   Each chunk is passed to the client first and inspected second, so
   watching the stream never delays it. Time to first byte and token
   counts are read on the way past.
8. **Complete.** When the stream ends, the log row is updated with
   the outcome and timings.

`saxby/<model>` and other model names skip steps 2 to 4 but are still
recorded, as `bypass` and `raw`.

##  The other routes

| Route | What it does |
| --- | --- |
| `GET /v1/models` | Lists `saxby` and `saxby/<model>` |
| `POST /saxby/v1/explain` | Runs steps 2 to 4 only; returns the decision |
| `GET /saxby/v1/status` | Instance, port, pid and version |
| anything else | Proxied to the backend unchanged, minus management |

Each route has its own file under `routes/`, named after it. The
catch-all lives in [`main.js`](../packages/llm-router/src/main.js) and
forwards headers as they arrive, minus `accept-encoding`,
`content-length` and `host`.
[Issue #22](https://github.com/saxby-tools/saxby/issues/22) covers what
that means for user-identifying headers.

##  The decision log

[`log/db.js`](../packages/llm-router/src/log/db.js) and
[`log/schema.js`](../packages/llm-router/src/log/schema.js). SQLite
through Deno's built-in `node:sqlite`, so there is no dependency and
nothing that complicates cross-compiling.

**Two-phase.** A row is inserted when the decision is made and
updated when the response finishes. A row that never got its update
is a request that never finished, which is worth counting.

**Off the request path.** `DatabaseSync` is synchronous, so writes
are queued and flushed in batches — every 50 rows or 500 ms,
whichever comes first — in one transaction. The insert and the update
share one queue, so an update can never land before its row exists.
On `SIGINT` or `SIGTERM` the queue is flushed before exit.

**Strict and migrated.** Tables are `STRICT`, so a bad write fails
loudly instead of being coerced. Migrations are append-only and
numbered. The file runs in WAL mode so a reader can open it while
Saxby writes.

**Views** for the questions asked most: `v_routing_funnel`,
`v_client_mix`, `v_unclaimed_tags`, `v_incomplete` and
`v_exemplar_cache`.

The log also holds Tier 3's exemplar vectors, keyed by embedding
model, which is why switching embedders back and forth re-embeds
nothing.

##  Instances and services

An instance is a folder holding one config, one log and its vectors
([`core/src/config/instance.js`](../packages/core/src/config/instance.js)).
Every command and the daemon resolve the instance the same way, and
`/saxby/v1/status` is how anything finds out which instance owns a
port. See [Instances](instances.md).

`saxby service` drives launchd or `systemd --user` through one
adapter per platform (`cli/src/services/`), each with the same
methods. See [Services](services.md).

##  Tests

Colocated as `*.test.js`, run with `deno task test`. They use fixture
catalogs and an injected embedder, so they need no daemon, no
backend and no user config. Assertions about real model names belong
in a personal script against `/saxby/v1/explain`, not the suite: one
machine's catalog is not a project rule.

One test guards a contract that drifted before: the extractor must
emit exactly the tags `EMITTABLE_TAGS` lists. The routing, logging
and config fixes made while writing the M6 docs each came with a test
that fails against the code before the fix.
