#  Routing

Saxby shows clients one model, `saxby`. Ask for it, and Saxby
reads the request, picks a model from your catalog, and forwards the
request there. This page explains how it picks, and how to see why it
picked what it did.

##  Three ways to ask

The `model` field of a chat request decides whether Saxby routes at
all:

| `model` | What happens |
| --- | --- |
| `saxby` | Saxby routes the request, as described below |
| `saxby/<model>` | Sent straight to `<model>`; no routing |
| anything else | Passed through unchanged; no routing |

`GET /v1/models` lists `saxby` plus `saxby/<model>` for every
catalog entry, so a client's model picker can offer both. Every
request is logged either way: routed requests with their tier,
the other two as `bypass` and `raw`.

##  The tiers

A routed request goes through up to three tiers, cheapest first. The
first tier that finds an answer wins. Each tier that declines records
why, so a surprising route can always be explained.

###  Tier 1: an explicit choice

If the last user message starts with `/` and a persona's name, as in
`/coder fix this`, that persona's `default_model` gets the request.
The `/coder` is removed before the model sees the prompt. An unknown
command is left alone, so you see your own typo instead of having it
silently eaten.

An explicit choice always wins, even over the checks below. It is
yours.

###  Tier 2: structure

Saxby scans the last user message for structure — code, file paths,
stack traces, tables, math — and turns what it finds into tags. The
scan works on structure, not words, so it behaves the same in any
language.

| Found | Tags |
| --- | --- |
| Code fences, inline code | `TAG_CODER` |
| A diff | `TAG_CODER` |
| A stack trace | `TAG_CODER`, `TAG_DEBUG` |
| A file path | `TAG_CODER` |
| Two or more distinct file paths | also `TAG_MULTI_FILE` |
| A JSON payload, CSV-style rows, a Markdown table | `TAG_DATA` |
| Block math, a LaTeX environment, a TeX macro | `TAG_MATH`, `TAG_REASONING` |
| An image | `TAG_VISION` |
| Audio | `TAG_AUDIO` |

Single-dollar math is deliberately not detected: currency shows up in
prompts far more often than inline LaTeX, and a `$` inside a code
fence is never math. File paths count wherever they appear, including
inside pasted code, since a path in a diff or stack trace is real
signal. Headings, lists and section headers are recorded as evidence
but produce no tag.

**Tier 2a** looks for catalog models whose `capabilities` claim those
tags. Each model scores one point per matching tag, and the highest
score wins. Ties go to a model some persona uses as its
`default_model`, then to the alphabetically first name, so reordering
your config file never changes a route.

**Tier 2b** runs only if no model matched. It looks for personas whose
`tags` match instead, and sends the request to the best one's
`default_model`. This keeps routing working while a catalog is only
partly tagged.

###  Tier 3: meaning

Tier 3 runs only when Tiers 1 and 2 both found nothing. It embeds the
prompt and compares it with every persona's exemplars. If the closest
persona's score clears the profile's `threshold`, its
`default_model` gets the request.

It also records the **margin**, the gap to the closest *other*
persona. A small margin means two personas are fighting over a
prompt, usually because their exemplars overlap. The score and margin
are logged even when Tier 3 loses, because a near miss is exactly the
number threshold tuning needs.

Tier 3 costs one embedding call, which is why it runs last. If the
embedder is down, routing continues without it.

###  The fallback

When no tier finds an answer, the request goes to
`global_default_model`.

##  Requirements

`TAG_VISION` and `TAG_AUDIO` are not preferences. A model that cannot
see is not a worse choice for an image, it is a broken one. So these
two tags filter instead of score: in both parts of Tier 2, a model
that does not claim the requirement is never considered, however well
it matches otherwise.

If no model in the catalog claims a requirement, nothing can serve
the request. Saxby refuses it instead of guessing, with a 400 and
code `unmet_requirement`:

```json
{
    "error": {
        "message": "No model in this Saxby catalog claims TAG_AUDIO, so nothing here can handle audio. Add TAG_AUDIO to the capabilities of a model that can.",
        "type": "invalid_request_error",
        "code": "unmet_requirement"
    }
}
```

Tier 3 is skipped in that case, and nothing is sent upstream. A
Tier 1 `/command` still goes where it was told.

##  Background requests

A request that sets `stream: false` is treated as background work —
the titles, tags and follow-up questions chat apps generate — and
gets `TAG_BACKGROUND`. Its structure is still recorded as evidence,
but produces no tags. Image and audio
requirements are kept. See [Configuration](configuration.md) for why, and how
to turn it off.

##  Fitting the context window

After a tier picks its candidates, Saxby checks that the request
fits. It estimates the size of the **whole** request — system prompt
and every earlier turn, not just the last message — at roughly four
characters per token, with code charged at a denser rate. Any
candidate whose `max_context` is smaller is skipped, with the reason
recorded.

If every candidate is too small, Saxby falls back to the global
default, but only if it fits and meets any requirement. Otherwise it
uses the capable model with the largest context window. If no model
in the catalog can take the request, it refuses with the size it
needed and the largest window available.

Images and audio are counted in the request but do not yet add to
its size.

##  Seeing why

`POST /saxby/v1/explain` takes the same body as a chat request and
returns the whole decision as JSON. It never calls the upstream: no
tokens, no model load. It is the safe way to test routing.

It reads `model` the way a chat request does. Send `saxby` to see
the tiers at work. A `saxby/<model>` or any other name comes back as
tier `bypass` or `raw` with that model selected, the same way the
decision log records it.

```bash
curl -s http://127.0.0.1:11435/saxby/v1/explain \
    -H "Content-Type: application/json" \
    -d '{"model": "saxby", "messages": [{"role": "user",
        "content": "move app/a.js into app/b.js"}]}'
```

The fields worth reading first:

| Field | Tells you |
| --- | --- |
| `decision.tier`, `decision.route` | Which tier answered, and how |
| `decision.selected_model` | Where the request would go |
| `decision.refusal` | The message a refused client would get |
| `intent.tags` | What Tier 2 found |
| `abstentions` | Why each tier that declined, declined |
| `semantic` | Tier 3's best match, score and margin, even when it lost |
| `skipped` | Candidates that did not fit, and why |

For many prompts at once, `saxby probe` prints Tier 3 scores and
margins for a list of prompts. Running the daemon with `--trace`
prints every decision and every abstention reason as requests arrive.
Every decision is also stored in the instance's decision log.

##  Examples

Real decisions from a five-model catalog, as `explain` reports them:

| Prompt | Tier | Why | Model |
| --- | --- | --- | --- |
| move app/a.js into app/b.js | 2 | `CODER`, `MULTI_FILE` | devstral-small-2 |
| what does src/main.js do | 2 | `CODER` | qwen3-coder-next |
| a Python traceback | 2 | `CODER`, `DEBUG` | qwen3-coder-next |
| a Markdown table | 2 | `DATA` | mistral-small3.2 |
| a block of LaTeX | 2 | `MATH`, `REASONING` | gemma4:31b |
| can you make this email friendlier | 3 | writer | gemma4:31b |
| how long do I boil an egg | fallback | general 0.545, under 0.6 | gemma4:31b |
| /writer move app/a.js into app/b.js | 1 | override | gemma4:31b |
| a title request, `stream: false` | 2 | `BACKGROUND` | phi4-mini |
| an image | 2 | `VISION` | gemma4:31b |

Tags are shown without their `TAG_` prefix. The egg question is a
near miss: Tier 3's best match scored under the threshold, so it was
recorded and the global default took the request. Adding an exemplar
like it to `general` would make it a Tier 3 match.

The same prompts route differently against a different catalog. That
is the point: the routes come from your config, not from Saxby.
