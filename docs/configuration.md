#  Configuration

Saxby reads one config file per instance, at boot. The quickest way
to get one is to let `saxby` write it from what your backend has
installed:

```bash
saxby config generate
```

It finds the backend, asks which model plays which role, suggests
capability tags, and writes the file. Everything below is for reading
and editing that file afterward.

##  Where it lives

The default instance reads `~/.config/saxby/config.jsonc`. A named
instance reads `~/.config/saxby/instances/<name>/config.jsonc`. If
`XDG_CONFIG_HOME` is set, it replaces `~/.config`. See
[Instances](instances.md).

The file is JSONC, so comments are allowed. A plain `config.json`
works too. If both exist, Saxby loads `config.jsonc` and warns that
it is ignoring the other one, so an edit to the wrong file does not
silently do nothing.

Saxby reads the config only at boot. After editing, restart:

```bash
saxby service restart
```

`deno task dev` restarts on code changes, not config changes. Stop
and start it after editing the dev instance's config.

##  A complete example

```jsonc
{
    "listen_port": 11435,
    "upstream_url": "http://127.0.0.1:11434",
    "global_default_model": "gemma4:31b",

    "catalog": {
        "gemma4:31b": {
            "name": "gemma4:31b",
            "max_context": 131072,
            "capabilities": ["TAG_REASONING", "TAG_VISION"]
        },
        "qwen3-coder-next:latest": {
            "name": "qwen3-coder-next:latest",
            "max_context": 262144,
            "capabilities": ["TAG_CODER", "TAG_MULTI_FILE"]
        },
        "phi4-mini:latest": {
            "name": "phi4-mini:latest",
            "max_context": 131072,
            "capabilities": ["TAG_BACKGROUND"]
        }
    },

    "personas": {
        "coder": {
            "tags": ["TAG_CODER", "TAG_MULTI_FILE", "TAG_DEBUG"],
            "exemplars": [
                "refactor this",
                "the loop runs one too many times"
            ],
            "default_model": "qwen3-coder-next:latest"
        },
        "general": {
            "exemplars": ["what's the weather like", "tell me a joke"],
            "default_model": "gemma4:31b"
        }
    },

    "semantic": {
        "active": "bge-m3:latest",
        "profiles": {
            "bge-m3:latest": {
                "model": "bge-m3:latest",
                "dim": 1024,
                "threshold": 0.6
            }
        }
    }
}
```

##  Top-level fields

| Field | Default | Meaning |
| --- | --- | --- |
| `listen_port` | `11435` | Port Saxby listens on, 1024 to 65535 |
| `upstream_url` | `http://127.0.0.1:11434` | The OpenAI-compatible backend |
| `global_default_model` | required | Catalog key used when nothing matches |
| `catalog` | required | The models Saxby may route to |
| `personas` | required | Named routing roles; may be empty |
| `semantic` | off | Tier 3 settings; leave out to disable |
| `route_background_tasks` | `true` | Treat `stream: false` as background |
| `log_prompts` | `false` | Store prompt text in the decision log |
| `client_names` | `{}` | Friendly names for client signatures |
| `client_defaults` | `{}` | Request fields filled in for a client; see [Client defaults](#client-defaults) |
| `log_path` | instance folder | Where the decision log lives |
| `memory` | all defaults | Memory broker settings; see [Memory](#memory) |
| `trusted_proxies` | `[]` | Proxies allowed to pass requests in; see [Trusted proxies](#trusted-proxies) |

Unknown fields are an error, not a warning. A misspelled key such as
`listen_prot` stops the boot instead of being ignored.

##  The catalog

Each key is a model id exactly as the backend knows it. The key is
what Saxby sends upstream, and what `global_default_model`,
`default_model` and the `saxby/<model>` bypass refer to.

| Field | Meaning |
| --- | --- |
| `name` | Required. Set it to the key; routing uses the key |
| `max_context` | The model's context window in tokens |
| `capabilities` | Tags this model should win, default none |
| `system_prefix` | Optional text sent as a system message to this model only |
| `description` | Optional note for humans |
| `pinned` | `true` keeps this model's space safe from heavy jobs, default `false` |
| `size_gib` | Optional size in GiB, used until the backend reports a whole load |

`max_context` matters. Saxby estimates the size of the whole
request, every message and not just the last one, and skips any model
the request would not fit. `config generate` reads it from the
backend.

`system_prefix` is merged into the first system message if there is
one, or added as a new first message. Several local models honor
only the first system message. Whatever was applied is recorded in
the decision log, so a response shaped by an injected prompt is never
invisible.

**An embedding model must never be in the catalog.** Anything in the
catalog can be picked as a chat target, and an embedder cannot answer
a chat request. Embedders belong only in `semantic.profiles`.
`config generate` keeps them out of the chat pickers.

`pinned` and `size_gib` belong to the memory broker. A pinned model's
space counts as taken whether it is loaded or not, so a job started
with `saxby reserve` can never displace it. Pin the models you keep
loaded. See [Memory broker](memory-broker.md).

##  Capability tags

Tags are how Tier 2 routes. Each request is scanned for structure —
code fences, file paths, stack traces, tables, math — and gets tags.
A model that claims a tag in `capabilities` is a candidate for it.

| Tag | Emitted for |
| --- | --- |
| `TAG_CODER` | Code fences, inline code, diffs, stack traces, file paths |
| `TAG_MULTI_FILE` | Two or more distinct file paths |
| `TAG_DEBUG` | Stack traces |
| `TAG_DATA` | JSON payloads, CSV-style rows, Markdown tables |
| `TAG_MATH` | Block math, LaTeX environments, TeX macros |
| `TAG_REASONING` | Math, alongside `TAG_MATH` |
| `TAG_BACKGROUND` | Requests that set `stream: false` |
| `TAG_VISION` | Image parts — a requirement |
| `TAG_AUDIO` | Audio parts — a requirement |

`TAG_WRITER` and `TAG_LONG_CONTEXT` are **reserved**. They are in the
vocabulary, but nothing emits them yet, so a claim on either never
matches. Saxby warns at boot if a config claims one. Writing prompts
reach a writer persona through its Tier 3 exemplars instead.

[Routing](routing.md) covers exactly how each one is detected.

**A tag is a routing preference, not a capability claim.** A model
that *can* write code should not claim `TAG_CODER` unless it is the
model code should go to. If two models claim the same tag, the tag
stops telling them apart.

**`TAG_VISION` and `TAG_AUDIO` are the exception.** They are
requirements. A request with an image only considers models that
claim `TAG_VISION`, because a model that cannot see is not a worse
choice for an image, it is a broken one. Claim them on every model
that genuinely can, and on none that cannot. They are separate
because a model may see without hearing.

`config generate` sets these two from what the backend reports for
each model, never from its name. One family can ship sizes with and
without them: gemma4's small E2B and E4B take audio, and its 31B does
not. If you add a model by hand, check what it accepts first. With
Ollama, `ollama show <model>` lists `vision` or `audio` under
Capabilities.

If no model in the catalog claims a requirement, nothing can serve
the request, and Saxby refuses it rather than guess. The client gets
a 400 with code `unmet_requirement` and a message naming the missing
tag. The refusal is logged with tier and outcome `refused`, and
`/saxby/v1/explain` shows it. An explicit `/command` still routes
where it was told to.

At boot, Saxby checks the tags in both directions and warns when:

- a claimed tag is reserved, so the claim can never match;
- a claimed tag is not in the vocabulary at all, which is almost
  always a typo;
- nothing claims a tag that can match, which leaves Tier 2 doing
  nothing;
- nothing claims `TAG_CODER` or `TAG_BACKGROUND`.

These are warnings, not errors. The router still runs, but the
symptom — everything falls back to the global default — looks like
working software, so read them.

##  Background tasks

With `route_background_tasks` on, which is the default, any request
that sets `stream: false` is tagged `TAG_BACKGROUND` and skips the
structural scan. Image and audio requirements are kept: a
non-streaming request with an image still only goes to a model that
claims `TAG_VISION`. Chat UIs generate titles, tags and follow-up
questions this way, and those prompts are full of headings, lists and
example file paths that belong to the template, not the user. Reading
intent from them once sent a title generator to a 51 GB coding model.

Claim `TAG_BACKGROUND` on a small, fast model so this work never
evicts a large one.

Most API clients and SDKs can also send non-streaming requests. If
yours does, those requests take the background route too. Set
`route_background_tasks` to `false` to turn the shortcut off;
non-streaming requests are then routed like any other.

##  Personas

A persona is a named role with a `default_model`.

| Field | Meaning |
| --- | --- |
| `default_model` | Required. The catalog key this persona routes to |
| `tags` | Tags that route to this persona when no model claims them |
| `exemplars` | Example prompts for Tier 3 |
| `description` | Optional note for humans |

Persona tags are Tier 2's second chance. If a request's tags match no
model's `capabilities` but do match a persona's `tags`, it goes to
that persona's `default_model`. Model capabilities win when both
match.

Exemplars are Tier 3's raw material. Each one is embedded once and
cached in the decision log. A prompt that no earlier tier claimed is
compared against all of them, and the closest persona wins if the
score clears the threshold. Two habits make them work:

- **Give each persona its own vocabulary.** For short prompts,
  sentence shape outweighs subject, so personas need nouns the others
  never use.
- **Cover requests and symptoms.** "Refactor this" and "the loop runs
  one too many times" sit in different parts of the vector space.

Keep a `general` persona with no tags and everyday exemplars. Tier 2
can never reach it, so off-topic prompts land there instead of on
whichever specialist happens to be nearest.

When a prompt lands on the wrong persona, **add an exemplar shaped
like it. Do not lower the threshold.** A missing exemplar looks
exactly like a threshold that is too high, and lowering the threshold
widens every persona at once. `saxby probe` shows scores and margins
without generating a token.

##  Semantic (Tier 3)

```jsonc
"semantic": {
    "active": "bge-m3:latest",
    "profiles": {
        "bge-m3:latest": {
            "model": "bge-m3:latest",
            "dim": 1024,
            "threshold": 0.6
        }
    }
}
```

`active` names the profile in use. Each profile gives the embedding
model, its vector size `dim`, and a `threshold` from 0 to 1. The
threshold lives inside the profile because a score from one embedder
means nothing for another.

Vectors are cached per embedding model, so switching `active` to
another profile and back does not re-embed anything. That makes
comparing two embedders a one-line change.

Tier 3 is optional. If the embedder cannot be reached at boot, Saxby
warns and keeps routing with Tiers 1 and 2.

The active profile's model is pinned for the memory broker without
being asked, since Tier 3 loads it. A profile may carry `size_gib`
like a catalog entry.

##  Logging

The decision log is a plain SQLite file in the instance's folder,
`decision-log.db`, with no password and no encryption. Anyone who can
read the file reads everything in it, and whoever runs Saxby always
can. So the log stores as little as it can.

**Prompt text is off unless you turn it on.** With `log_prompts`
unset or `false`, each prompt is stored as a keyed hash, which groups
repeats and regenerations without keeping the words. Routing
decisions, tags, timings and token counts are logged either way.
`saxby config generate` asks, and writes the answer to the file.
saxbyd says which way it is set at every boot.

```jsonc
"log_prompts": true
```

What the log keeps about a prompt with text off: its length in
characters and lines, an estimated token count, how much of it was
code, and counts of what the structural detectors saw, such as how
many file paths or code fences it held. Never the paths, never the
code, never a heading. A fence's language name is kept when it looks
like one (`js`, `c++`), and dropped when it does not.

**The hash is keyed per instance.** The key is 32 random bytes in
`prompt-hash.key`, beside the config, made on first boot and never
rotated by Saxby. A plain hash would let anyone with the file hash a
guess and confirm a short prompt. The key sits next to the log, so it
protects a log you share on its own, not a stolen folder, which holds
both. Delete the file to start a new key; grouping starts over from
there. Rows written before v0.9.7 keep their plain hashes, and every
row says which it has in `prompt_hash_scheme`: `sha256` or
`hmac-sha256`. Rows from either side cannot be grouped together.

**Files are owner-only.** saxbyd makes the log, its `-wal` and `-shm`
files and the folder holding them readable by you alone on every
boot, and says so when it changed something. `config generate`
creates the folder that way from the start.

**Removing text already stored.** If an older install logged prompt
text you no longer want, stop the service, then:

```bash
sqlite3 ~/.config/saxby/decision-log.db \
    "UPDATE decision_log SET prompt = NULL; VACUUM;"
```

Then start it again. `VACUUM` rewrites the file, which is why the
service has to be stopped, and it is what removes the old text from
the file's free pages. Rows written by v0.9.7 or later are zeroed as
they go. Backups made before this keep the text regardless.

The log also holds a copy of each persona's exemplars, since Tier 3
caches their vectors there. That is your config, not anyone's chat,
but it is in the file.

`client_names` turns a client's signature into a friendly name in the
log. The signature is the first word of the `User-Agent` in
lowercase — `OpenClaw/2026.6.11` becomes `openclaw` — or `open-webui`
when Open WebUI's own headers are present:

```jsonc
"client_names": { "python-httpx": "my-script" }
```

The raw `User-Agent` is stored on every row too, so a name added
later still applies to old traffic.

###  Client defaults

`client_defaults` fills in a request field for one client when the
request leaves it out. It is for a client you cannot configure, such
as a phone keyboard that sends a fixed request. The key is the same
signature `client_names` uses:

```jsonc
"client_defaults": {
    "leantype": { "reasoning_effort": "none" }
}
```

`reasoning_effort` is the only field, and `"none"` is its only value.
It turns off a model's reasoning for that client. On the reference
setup, one grammar fix on a 31B model took 5.2 seconds with reasoning
and 0.6 without, with the same answer.

Three rules:

- A value the client sends always wins. Saxby only fills a gap.
- It applies however the request names a model: `saxby`,
  `saxby/<model>` or a raw name.
- What Saxby added is stored on the row, in the `client_defaults`
  column, and printed by `--verbose` as a `DEFAULT` line. A row with
  nothing there was sent as the client wrote it.

Only `"none"` is accepted because it is the only value safe on every
model. Ollama answers 400 to any other value when the model has no
reasoning to turn down, and routing may pick such a model.

The signature comes from the `User-Agent`, which any client can set.
That is fine for a preference like this one. It is not a way to
restrict what a client may do.

`log_path` moves the decision log. Leave it unset in a named instance:
its log then stays in the instance's folder. See
[Instances](instances.md).

##  Trusted proxies

Saxby listens on `127.0.0.1` and refuses every request that came
through a proxy. `trusted_proxies` names the one exception: Tailscale
Serve, so your own devices can reach Saxby over your tailnet.

```jsonc
"trusted_proxies": [
    { "kind": "tailscale-serve", "host": "my-mac.my-tailnet.ts.net" }
]
```

`kind` is always `tailscale-serve`; no other proxy can be named.
`host` is the machine's full tailnet name, with no `https://` and no
port. It is empty by default, and `saxby config generate` leaves it
out.

Saxby does not set Tailscale up. On the machine running Saxby,
something like this publishes it to your tailnet over HTTPS:

```bash
tailscale serve --bg --https 11435 http://127.0.0.1:11435
```

Clients then use `https://my-mac.my-tailnet.ts.net:11435/v1`.

**Saxby still checks no credentials.** A token the client sends is
ignored. Whoever your tailnet's access rules let reach this machine
on that port can use Saxby, so those rules are the lock. That suits
one person's tailnet. On a shared one, restrict the port in
Tailscale first.
[Issue #49](https://github.com/saxby-tools/saxby/issues/49) tracks a
token. Every boot prints the trusted proxy, so it is never on
quietly.

What Saxby does check is that a proxied request fits Serve and
nothing else. All of these must hold:

- The connection comes from this machine.
- `Host` is the configured `host`.
- The only forwarding headers are the three Serve sends:
  `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto`.
- `X-Forwarded-For` is one tailnet address.
- It did not come through Tailscale Funnel, which is the public
  internet.
- It did not come from a web page.

A request that fails one gets a 403 that says which; see
[Troubleshooting](troubleshooting.md#proxy_not_trusted).

Proxied clients reach `/v1/chat/completions` and `/v1/models` only.
The memory broker, the status and explain routes and Ollama's own API
stay on this machine.

Two limits to know:

- The decision log names the app, from its `User-Agent`, as it does
  for local clients. It does not record which person or device
  called.
  [Issue #50](https://github.com/saxby-tools/saxby/issues/50) tracks
  that.
- A program on this machine can send the same headers Serve does.
  It could already call Saxby directly, so this gives it nothing new.

##  Memory

```jsonc
"memory": {
    "margin_gib": 8,
    "wait_timeout_s": 120,
    "heartbeat_interval_s": 10
}
```

Settings for the memory broker, which keeps heavy GPU jobs and model
loads from overfilling GPU memory. The section is optional and the
broker is always on.

| Field | Default | Meaning |
| --- | --- | --- |
| `margin_gib` | `8` | Kept free beyond every model and job |
| `wait_timeout_s` | `120` | How long a job or model load waits for room |
| `heartbeat_interval_s` | `10` | How often jobs check in and dead ones are dropped |
| `ceiling_gib` | none | The GPU's maximum, used only when it can't be measured |

On Linux, set `ceiling_gib`: the Linux probe measures no ceiling yet,
and without one every job is refused. See
[Memory broker](memory-broker.md).

##  When the file is wrong

A config that fails validation stops the boot. Saxby prints
`❌ Invalid config in <path>:` and lists everything that failed; see
[Troubleshooting](troubleshooting.md). Besides the field rules
above, it checks that every model named anywhere exists in the
catalog — `global_default_model`, each persona's `default_model`, and
`semantic.active` among the profiles.

A config that is not valid JSON or JSONC also stops the boot and
names the file.
