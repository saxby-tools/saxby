#  Clients

Anything that speaks the OpenAI chat API can use shuntd. Point it at
shuntd instead of your backend, and ask for the model `shuntd`.

##  The three settings every client needs

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:11435/v1` |
| API key | anything non-empty |
| Model | `shuntd` |

shuntd does not check the API key. It passes the `Authorization`
header on to the backend, and Ollama ignores it, but many clients
refuse to start without one. Clients are told apart by their
`User-Agent`, never by their key.

Use `shuntd/<model>` to skip routing and reach one model directly.
See `docs/routing.md`.

##  Open WebUI

These settings were checked against Open WebUI v0.12.0 running in
Docker.

###  Connecting

Set the connection in the container's environment:

```
OPENAI_API_BASE_URL=http://host.docker.internal:11435/v1
OPENAI_API_KEY=shuntd
ENABLE_OLLAMA_API=false
```

`host.docker.internal` is how a container reaches your machine. It
works out of the box with Docker Desktop on macOS. On Linux, start
the container with `--add-host=host.docker.internal:host-gateway`.

**Turn off Open WebUI's own Ollama connection** with
`ENABLE_OLLAMA_API=false`. Otherwise Open WebUI talks to Ollama
directly as well, and every request it sends that way skips routing
and never reaches the decision log.

The same connection can be added in the admin panel under Settings,
Connections, instead of the environment.

###  The task model

Open WebUI generates chat titles, tags and follow-up questions in the
background. It sends those requests to a **task model**: the External
Task Model in the admin panel's Settings, Interface, when one is set,
and otherwise the same model the chat uses.

Set the **External Task Model to `shuntd`**. If a chat uses `shuntd`,
background work is routed either way. But if someone picks
`shuntd/gemma4:31b` to talk to one model directly, an unset task model
sends every title request to that large model too.

Open WebUI sends this background work with `stream: false`, which
shuntd routes to the model claiming `TAG_BACKGROUND` — a small, fast
one, ideally. See `docs/configuration.md`.

###  Telling Open WebUI apart in the log

With default settings, Open WebUI's requests carry the `User-Agent`
of its HTTP library, so the decision log calls it `python`. To have it
logged as `open-webui`, set:

```
ENABLE_FORWARD_USER_INFO_HEADERS=true
```

That makes Open WebUI send each user's name, id, email and role as
headers. shuntd only checks that the headers are present. It never
stores their values, and it does not pass them on to the backend.
Whether that is worth it is your call; without it, everything still
works and the client is simply logged as `python`.

If you also set `FORWARD_USER_INFO_HEADER_JWT_SECRET`, Open WebUI
sends one signed `X-OpenWebUI-User-Jwt` header instead, which shuntd
also recognizes. If you rename these headers with the
`FORWARD_USER_INFO_HEADER_*` variables, shuntd will not recognize
them.

###  A second connection for dev

To try a dev build from the same Open WebUI, add a second connection
to `http://host.docker.internal:11436/v1` — the `dev` instance from
`deno task dev` — and give it the Prefix ID `dev`. Its models appear
as `dev.shuntd` and `dev.shuntd/<model>` beside the real ones. Open
WebUI removes the prefix before the request reaches shuntd. See
`docs/instances.md` for the dev instance.

##  OpenClaw

OpenClaw takes shuntd as a custom provider in `openclaw.json`:

```json
{
    "models": {
        "providers": {
            "shuntd": {
                "baseUrl": "http://127.0.0.1:11435/v1",
                "api": "openai-completions",
                "apiKey": "shuntd",
                "models": [
                    {
                        "id": "shuntd",
                        "name": "shuntd",
                        "contextWindow": 128000,
                        "input": ["text", "image", "audio"]
                    }
                ]
            }
        }
    },
    "agents": {
        "defaults": {
            "model": { "primary": "shuntd/shuntd" }
        }
    }
}
```

`shuntd/shuntd` is OpenClaw's own `provider/model` naming: the
provider called `shuntd`, its model `shuntd`. It is not shuntd's
`shuntd/<model>` bypass, which would skip routing.

List `image` and `audio` under `input` only if your catalog has
models that claim `TAG_VISION` and `TAG_AUDIO`. Otherwise OpenClaw
offers attachments that shuntd will refuse.

OpenClaw sizes conversations against `contextWindow`. shuntd checks
each request against the chosen model's `max_context` and moves on to
a bigger model when one is too small. A window larger than your
smallest models means long conversations get rerouted, and refused
only when no model in the catalog fits.

OpenClaw uses the OpenAI JavaScript SDK, so the decision log calls it
`openai`. To name it, add this to shuntd's config:

```json
"client_names": { "openai": "openclaw" }
```

Any other client built on the same SDK gets the same name — on one
machine, OpenClaw and another app both logged as `openai`, so this
mapping would mislabel the other one. Issue #21 tracks a way to tell
them apart.

OpenClaw's memory search can embed text through Ollama directly.
Those calls do not pass through shuntd and are not logged.

##  Scripts and SDKs

`curl`, the OpenAI SDKs and your own scripts work with the three
settings above. Two things to know:

- A request with `stream: false` is routed as background work. Most
  SDKs can send non-streaming requests, so a script that does will
  land on your background model. Set `route_background_tasks` to
  `false` if that is wrong for you. Issue #1 tracks a better rule.
- The log names a script by the first word of its `User-Agent`:
  `python`, `node`, `curl`, `openai`. Use `client_names` to tell them
  apart.

##  Who owns what

When one AI tool sits in front of another — Open WebUI in front of an
agent, an agent in front of shuntd — each layer should own its own
decisions and leave the rest alone.

shuntd owns **which model** answers. A client that picks a specific
model, or swaps models on its own schedule, is making that decision
twice, and the two will disagree. Ask for `shuntd` and let the router
decide.

The same goes the other way. When a chat UI sits in front of an
agent, every feature the UI also offers — its own memory, its own
system prompt, its own web search, its own title generation — is a
second opinion about something the agent already decided. Turn those
off in the outer layer and let the layer doing the work own them.
