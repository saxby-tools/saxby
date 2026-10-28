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
| `log_prompts` | `true` | Store prompt text in the decision log |
| `client_names` | `{}` | Friendly names for client signatures |
| `log_path` | instance folder | Where the decision log lives |
| `memory` | all defaults | Memory broker settings; see [Memory](#memory) |

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

`log_prompts: false` stores a hash of each prompt instead of its
text. Routing decisions, tags and timings are still logged.

`client_names` turns a client's signature into a friendly name in the
log. The signature is the first word of the `User-Agent` in
lowercase — `OpenClaw/2026.6.11` becomes `openclaw` — or `open-webui`
when Open WebUI's own headers are present:

```jsonc
"client_names": { "python-httpx": "my-script" }
```

The raw `User-Agent` is stored on every row too, so a name added
later still applies to old traffic.

`log_path` moves the decision log. Leave it unset in a named instance:
its log then stays in the instance's folder. See
[Instances](instances.md).

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
