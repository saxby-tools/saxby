# Memory broker

Saxby keeps heavy GPU jobs and model loads from overfilling GPU
memory. Put `saxby reserve` in front of a heavy command:

```bash
saxby reserve --gib 12 -- upscayl-bin -i in.png -o out.png
```

The job waits until 12 GiB is free, then runs with PyTorch capped at
12 GiB. It never takes the space of a model you marked as pinned. If
it can't get the memory in time, it is refused with a reason. If
saxbyd can't be asked at all, the job does not run.

While a job holds memory, Saxby also makes requests wait before they
load a model that would not fit, whether they come to its chat route
or to one of Ollama's own inference paths through the catch-all. With
no job running, requests are not checked, but every model the chat
route loads is counted until the backend lists it, so a job cannot
start in its space.

## Why it exists

On Oct. 27, 2026, a PyTorch job on a Mac's GPU grew to 122 GiB while
two models held about 40 GiB. On Apple Silicon, GPU memory is
"wired": it cannot be paged out. Wired memory reached 123.7 of
128 GiB, the system froze, and the kernel panicked.

Two things were missing. Nothing kept the job from starting while the
models were loaded, and nothing kept it from growing once it ran. The
broker fixes the first; the PyTorch cap fixes the second.

## Using it

```
saxby [-i <name>] reserve --gib <N> [--timeout <s>] [--label <text>]
    [--no-broker] -- <command> [args...]
```

| Flag          | Meaning                                                    |
| ------------- | ---------------------------------------------------------- |
| `--gib`       | Required. GPU memory to reserve, in GiB; decimals are fine |
| `--timeout`   | Seconds to wait for room. Default: `memory.wait_timeout_s` |
| `--label`     | Name in the log. Default: the command's name               |
| `--no-broker` | Run without asking saxbyd. Prints a warning                |
| `-i`          | Ask a named instance's saxbyd instead of the default one   |

The `--` is required. Everything after it is the job, passed through
untouched, so the job's own flags are never read as Saxby's.

Messages from `saxby reserve` go to stderr. The job's stdout stays
its own.

Size the reservation to the job's peak, not its average. The PyTorch
cap makes a job that goes over fail with an out-of-memory error.

### Exit codes

| Code      | Meaning                                                     |
| --------- | ----------------------------------------------------------- |
| the job's | The job ran; this is its own exit code                      |
| 128 + n   | The job was killed by signal n (143 for SIGTERM)            |
| 2         | A usage error, such as no command after `--`                |
| 69        | saxbyd could not be asked, so nothing ran                   |
| 75        | saxbyd refused: no room within the timeout, or never enough |
| 127       | The command could not be started                            |
| 130       | You pressed Ctrl-C while it waited; nothing ran             |

75 means "try again later." 69 means "the broker is missing." A skill
can retry on the first and should stop on the second.

### Signals

`SIGTERM` sent to `saxby reserve` is passed on to the job. Ctrl-C in
a terminal already reaches the job, because both share the terminal's
process group, so the wrapper does not pass it on a second time. A
second Ctrl-C can cut a job's own cleanup short.

## The budget

One formula decides both jobs and model loads:

```
free = ceiling - margin - pinned - loaded - reserved
```

| Term     | What it is                                                    |
| -------- | ------------------------------------------------------------- |
| ceiling  | The most the GPU may hold. On macOS, `iogpu.wired_limit_mb`   |
| margin   | Kept free beyond everything else. `memory.margin_gib`         |
| pinned   | Every pinned model at full size, loaded or not                |
| loaded   | Every other model the backend holds now, `size_gib` or more   |
| reserved | Every job, plus forwarded loads the backend does not list yet |

A job of N GiB runs when N fits in `free`.

**Pinned models count even when they are not loaded.** That is what
"a job never takes a pinned model's space" means. If a pinned model
has unloaded, its space is still held for it.

**Other loaded models count too.** A job cannot evict a model, so a
model loaded for one request holds its space until the backend
unloads it. That includes models loaded straight through Ollama, by
clients that skip Saxby.

**A loaded model is counted at the larger of what the backend reports
and its `size_gib`.** Pinned or not, in the catalog or in the
embedder's profile. A model the config gives no size keeps the
backend's number. A larger report always wins, since a bigger size
only makes the broker more careful; a smaller one never lowers the
count, because the backend's number can be wrong in the one direction
that matters.

For a model on Ollama's MLX runner, it is. Ollama books such a model
at the runner's memory at load time, which is the weights, and never
asks again. The KV cache then grows with every conversation, and
MLX's memory is pageable, so the Mac's wired-memory probe does not
see it either. On Oct. 30, 2026, a model booked at 16.9 GiB held
78.8 GiB when the reference machine panicked. The real fix is
upstream: Ollama booking an honest size, which the broker would
inherit with no change. Until then, a well-set `size_gib` and this
floor are what keep a job out of memory the model is already using
([#45](https://github.com/saxby-tools/saxby/issues/45)). Set it to
the model's size at the context length it is loaded with, not to the
weights alone.

**A request that can never fit is refused at once.** If N is more
than the ceiling minus the margin and the pinned models, waiting
would not help, so there is no wait.

**An unknown is never free memory.** If any term cannot be known,
nothing is admitted. The refusal says which term:

- the ceiling cannot be measured (see [Platforms](#platforms))
- the backend did not answer `/api/ps`
- a pinned model has no known size
- a model Saxby is loading has no known size

The first and the third are config gaps: waiting cannot fill them, so
a job is refused at once rather than after `wait_timeout_s`. The
second may clear on the next poll, and the fourth ends with the
request that is loading the model, so a job waits for those.

The current budget, in bytes:

```bash
curl -s http://127.0.0.1:11435/saxby/v1/reservations
```

## Pinned models

Mark a model pinned in the catalog:

```jsonc
"gemma4:31b-128k": {
    "name": "gemma4:31b-128k",
    "max_context": 131072,
    "pinned": true,
    "size_gib": 26
}
```

Pin the models you keep loaded all the time: the default model, a
background model. Leave a model you load now and then unpinned.

The active embedder in `semantic` is pinned without asking. Tier 3
loads it for routed requests, and embedders never sit in the catalog,
where the `pinned` field lives. Its profile takes `size_gib` too.

A pinned model's size comes from, in order:

1. what the backend reports now, if it is loaded
2. the largest size the backend has reported for it loaded whole
3. `size_gib` in the config

`size_gib` is also a floor under the first two: a report smaller than
it is counted at `size_gib`, as for any loaded model
([The budget](#the-budget)).

Only a whole load is a measurement. When memory is tight, Ollama
spills layers to the CPU, and the GPU part it reports then is less
than the model needs to load whole; remembering it would undercount
the pinned model from then on. Such a load still counts as loaded,
at the GPU size it holds now, but it is not remembered.

The largest whole load wins, not the latest. A model's size depends
on the context length it was loaded with, and that differs by
client: Saxby's chat route sends `/v1/chat/completions`, which
ignores `num_ctx`, so Ollama loads the model at its own default,
while a client on Ollama's `/api` paths can ask for a smaller one.
Had the smaller load replaced the bigger size, the broker would have
counted less than Saxby's own load of the model needs once it
unloaded, and a job could have been admitted into the difference. An
unusually large load inflates the number instead, which errs the safe
way: a bigger size only makes the broker more careful.

Sizes from the backend are kept in the decision log's file, in the
table `model_sizes`, so a saxbyd restart does not forget them. They
are read at boot, so to start over, stop saxbyd, clear the table,
and start it again:

```bash
sqlite3 ~/.config/saxby/decision-log.db "DELETE FROM model_sizes;"
```

Every model is then unknown until it loads whole again or `size_gib`
fills in. If none of the three exists, the size is unknown, and
**every job is refused until it is known**. The boot log says so:

```
🧮 Memory broker: ceiling 96.0 GiB (iogpu.wired_limit_mb), margin 8.0 GiB
   pinned: gemma4:31b (size unknown), granite4:micro-h 4.5 GiB (size_gib)
⚠️  Jobs will be refused until this is fixed: pinned model 'gemma4:31b' has no known size; load it once, whole, or give it size_gib
```

That fixes itself the first time the model loads whole. Set
`size_gib` to skip the wait. A measured size larger than `size_gib`
wins, since the real size grows with the context length the backend
loads; a smaller one does not, so `size_gib` is the least the model
is ever counted at, loaded or not.

## Model loads

Ollama decides whether a model fits by looking at memory that is free
right now. A job that has reserved 40 GiB but not used it yet looks
free. So while a job holds a reservation, Saxby checks each request
that names a model before it is sent to the backend:

- **No job held:** not checked. No call to the backend, no wait. The
  load is still counted, as described below.
- **The model is loaded:** sent at once.
- **The model is pinned:** sent at once. Its space is already held.
- **Otherwise:** sent once its size fits in `free`. Until then it
  waits, up to `memory.wait_timeout_s`, then gets HTTP 503.

A real one, from a test with a 5-second wait:

```json
{
    "error": {
        "message": "Saxby is holding GPU memory for a running job: waited 5 s; 'e2e-mid:1b' needs 40.0 GiB; 10.3 GiB free (ceiling 96.0 GiB - margin 8.0 GiB - pinned 30.5 GiB - loaded 26.2 GiB - reserved 21.0 GiB)",
        "type": "server_error",
        "code": "memory_unavailable"
    }
}
```

A model's size is the larger of the biggest whole load the backend
has reported for it and the catalog's `size_gib`, as for a pinned
model. A model with neither waits until no job is held.

`saxby/<model>` bypass requests and raw model names are checked the
same way. They load models too.

`POST /saxby/v1/explain` reports the routing decision and never
calls the backend, so it cannot say whether a request would wait.
That verdict depends on what is loaded at that second, a fact about
the machine, not the request. `GET /saxby/v1/reservations` shows the
budget now, and the `memory_events` table records what the gate
decided for real requests ([The log](#the-log)).

### Which paths are gated

Saxby's own chat route, `POST /v1/chat/completions`, and the six
paths the catch-all forwards whose body names a model:

| Path                                | What it is                       |
| ----------------------------------- | -------------------------------- |
| `/api/chat`, `/api/generate`        | Ollama's own chat and completion |
| `/api/embed`, `/api/embeddings`     | Ollama's own embedding           |
| `/v1/completions`, `/v1/embeddings` | OpenAI-style, passed through     |

On the catch-all paths, a JSON POST is read for its `model` field
only while a job holds memory. With no job held, and on every other
path, the request streams through untouched. A body that is not
JSON, or names no model, is forwarded as it came: the broker cannot
judge a load it cannot name, and the backend answers for the request.

A catch-all request has no decision-log row, so a refused one has no
`memory_refused` outcome there, but its `memory_events` row is
written like any other. Logging `/v1/embeddings` as a route of its
own is post-v1 backlog.

Clients that call Ollama directly, on its own port, never pass
through Saxby and cannot be gated by it (see [Limits](#limits)).

Every forwarded chat request's model is held in the ledger until
the response's first byte arrives, job or no job; a catch-all request
takes a hold only when it was gated
([#71](https://github.com/saxby-tools/saxby/issues/71)). By then the backend
lists the model, and its size counts as loaded instead; a model the
backend lists is never counted twice. Until then, the space the model
is about to take is not free: without the hold, two different models
could both be let through into the same free space, and a job that
arrives while a model is still loading could be admitted into its
space. The hold costs no call to the backend: the model is counted
at the larger of the size the backend last reported for it and its
`size_gib`. With neither, its size is unknown, and a job waits until
the hold ends. A pinned model needs no hold; its space is already held.

A second request for the same model, while it is still loading,
joins that hold rather than adding one: the backend loads the model
once, so its size counts once. The hold stays until the last request
sharing it has its first byte.

A hold can end while the backend is being asked what it has loaded.
The answer may then be from before the model was listed, and the
model would count nowhere. The broker notes how many holds have
ended before each read and, when the count moved during it, reads
again before deciding. After three such reads in a row the answer is
treated as unknown for that poll, which makes the job or load wait.

The decision-log row of a refused request has the outcome
`memory_refused`. Its `request_id` matches a row in `memory_events`
that says why.

## Reservations end with their process

A reservation lists two processes: the `saxby reserve` wrapper and
the job it started. Every heartbeat interval, saxbyd asks whether
each is still alive, with `kill -0`. When both have exited, the
reservation is dropped and the drop is logged as a reap. A crashed
job cannot leak its memory.

If the wrapper is killed with `SIGKILL`, its job keeps running, and
so does the reservation, until the job exits too.

`kill -0` only answers for processes of the user saxbyd runs as. A
reservation for any other process, such as pid 1, is refused.

If saxbyd restarts, it forgets every reservation. Each running
wrapper finds out on its next check-in and registers again with the
same id, without a budget check, since its job already holds the
memory. The log row shows the budget anyway, and says if it is over.

If saxbyd cannot check processes at all, it keeps every reservation
and warns once. Dropping one whose job still holds memory is the
unsafe direction.

## The cap inside a job

On macOS, `saxby reserve` sets two variables in the job's
environment:

```
PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.125000
PYTORCH_MPS_LOW_WATERMARK_RATIO=0.102941
```

That is a 12 GiB reservation under a 96 GiB ceiling. PyTorch's GPU
allocator then stops at 12 GiB with an out-of-memory error. Its
default ratio, 1.7, is no limit on unified memory.

Both are set because of two traps in PyTorch's allocator:

- **A ratio of 0 turns the cap off.** A reservation too small to show
  as a ratio is refused instead of sent as 0.
- **The low watermark may not be above the high one.** The low one
  defaults to 1.4. Setting only the high one below 1.4 makes PyTorch
  fail at startup. The low one is set at PyTorch's own 1.4 : 1.7
  proportion.

Ratios round down, so the cap never lands above the reservation.

**The cap is set only when the ceiling was measured.** PyTorch's
ratio is a ratio of Metal's own number, which `iogpu.wired_limit_mb`
equals when it is set. When it is 0, the macOS default, the broker's
ceiling comes from `memory.ceiling_gib`, which may sit anywhere
relative to Metal's default, and a ratio of it would land the cap
above or below the reservation by the same error. `saxby reserve`
then says the cap was not set and why; the reservation still stands.
Set the ceiling with `saxby vram-guard-mac` to get the cap.

**MLX jobs cap themselves.** MLX reads no environment variable for
its memory limit. Its Metal allocator picks a default at startup,
1.5 times Metal's recommended working set, and only a call changes it
(`mlx/backend/metal/allocator.cpp`, checked at v0.32.4). So on every
platform `saxby reserve` puts the reservation in the job's
environment, in whole bytes:

```
SAXBY_RESERVED_BYTES=12884901888
```

An MLX script reads it and sets the limit before it allocates:

```python
import os
import mlx.core as mx

reserved = os.environ.get("SAXBY_RESERVED_BYTES")

if reserved:
    mx.set_memory_limit(int(reserved))
```

`mx.set_memory_limit` is the current name; `mx.metal.set_memory_limit`
is deprecated and prints a warning. MLX's limit is softer than
PyTorch's. When active memory is over it, `mx.eval` waits for the
work already in flight to finish before it goes on, so freed buffers
come back sooner; an allocation fails only once RAM and swap are
gone. A job whose live arrays need more than the limit still grows
past it, so size the reservation to the job's peak, as with PyTorch.

Two other MLX calls are not caps. `mx.set_cache_limit` bounds the
pool of freed buffers MLX keeps for reuse; mflux's `--low-ram` and
`--mlx-cache-limit-gb` set that one, for `mflux-generate` and
`mflux-upscale-seedvr2` alike. `mx.set_wired_limit` says how much to
keep resident, and mlx-lm sets it to Metal's recommended working set.
Neither stops a job from growing. `saxby reserve` cannot make the
call for a job: the limit lives inside the process, and mflux and
mlx-lm take no flag for it. The ledger counts an MLX job either way,
so it cannot start beside models it would not fit with.

## When saxbyd cannot be asked

The broker fails closed. `saxby reserve` refuses to run the job, and
exits 69, when:

- saxbyd does not answer on the instance's port
- the instance has no config, so there is no port to ask
- saxbyd answers but has no broker (a saxbyd older than the CLI)

`--no-broker` runs the job anyway. It prints a warning and still sets
the PyTorch cap if it can measure the ceiling itself. The job is
invisible to saxbyd: model loads will not wait for it.

If saxbyd restarts while a job runs, the wrapper registers the job
again on its next heartbeat. Should saxbyd refuse that, the wrapper
says so once, and the job runs on uncounted; saxbyd is not asked
again.

## Config

```jsonc
"memory": {
    "margin_gib": 8,
    "wait_timeout_s": 120,
    "heartbeat_interval_s": 10
}
```

The whole section is optional. The broker is always on.

| Field                  | Default | Meaning                                              |
| ---------------------- | ------- | ---------------------------------------------------- |
| `margin_gib`           | `8`     | Kept free beyond every model and job                 |
| `wait_timeout_s`       | `120`   | How long a job or model load waits for room          |
| `heartbeat_interval_s` | `10`    | How often wrappers check in and dead jobs are reaped |
| `ceiling_gib`          | none    | The ceiling, used only when it can't be measured     |

**The margin** is room for what the budget cannot see: memory the
kernel wires for itself, and a model whose real size has drifted from
its last report. Every log row stores the wired memory the system
observed beside the budget, so the margin can be tuned against
evidence later.

**The wait** is long enough for a short job ahead to finish. It
applies to model loads too, so a client waits this long before it
gets a 503.

**The heartbeat** sets how long a dead job's memory stays held: at
most one interval.

**`ceiling_gib`** fills in only when the probe cannot measure the
ceiling. A measured ceiling always wins. Set it to the GPU's real
maximum; a guess that is too high lets the broker overfill the GPU.

## The API

All under `/saxby/v1/reservations`, behind the same guard as every
route: local, non-browser clients only. Sizes are whole bytes.

`POST /saxby/v1/reservations` asks for memory. The request stays open
while saxbyd waits.

```json
{ "gib": 12, "pid": 4242, "label": "upscayl-bin", "timeout_s": 120 }
```

201, admitted:

```json
{
    "reservation": {
        "id": "0b6c1a6e-8f8e-4c55-9d1a-2f4f6f0e9a11",
        "bytes": 12884901888,
        "label": "upscayl-bin",
        "pid": 4242,
        "child_pid": null,
        "created_at": "2026-10-28T00:21:03.512Z",
        "last_heartbeat_at": "2026-10-28T00:21:03.512Z"
    },
    "heartbeat_interval_s": 10,
    "ceiling_bytes": 103079215104,
    "ceiling_source": "iogpu.wired_limit_mb",
    "waited_ms": 0
}
```

`ceiling_source` says where the ceiling came from; the PyTorch cap
is set only when it is `iogpu.wired_limit_mb`.

503, refused, with `error.code` `memory_unavailable` and the whole
`budget`. 400 for a bad body or a pid that is not this user's.

A wrapper registering again after a restart sends the same body plus
`"id"`, `"child_pid"` and `"reregister": true`.

`POST /saxby/v1/reservations/:id/heartbeat` with
`{ "child_pid": 4243 }` checks in. 404 with `reservation_unknown`
means saxbyd restarted.

`DELETE /saxby/v1/reservations/:id` releases.

`GET /saxby/v1/reservations` returns `budget`, `reservations` and
`holds`.

## The log

Every wait, admission, refusal, release and reap is a row in the
`memory_events` table of the instance's decision log. Each row holds
the budget it was judged by, term by term, plus the wired memory the
system observed at that moment. Only a command's name is stored,
never its arguments.

Logging is best-effort, like the rest of the decision log. A failed
write changes no decision.

The `v_memory_events` view shows the rows in GiB, newest first:

```bash
sqlite3 -header -column ~/.config/saxby/decision-log.db \
    "SELECT at, subject, event, what, gib, free_gib, reason
     FROM v_memory_events LIMIT 20;"
```

`subject` is `job` or `load`. `event` is one of `wait`, `admit`,
`refuse`, `abandon` (the client left while waiting), `reregister`,
`release` and `reap`.

`wait_ms` runs from the request to the decision, including the time
to read the probe and the backend. On an M5 Max that is about 50 ms,
so an admission with no wait still shows a small number.

Chat requests that were refused, with their reasons:

```bash
sqlite3 -header -column ~/.config/saxby/decision-log.db \
    "SELECT d.received_at, d.requested_model, m.reason
     FROM decision_log d JOIN memory_events m USING (request_id)
     WHERE d.outcome = 'memory_refused' AND m.event = 'refuse';"
```

## Platforms

Each platform's code sits behind a small adapter, like the service
and backend adapters.

**macOS on Apple Silicon** is complete. The ceiling is
`iogpu.wired_limit_mb`, which `saxby vram-guard-mac` sets. When it is
0, macOS uses its own default, and only Metal reports that. Ollama
logs it but has no API for it, so the broker calls the ceiling
unknown and uses `memory.ceiling_gib`; the boot line says so, and
the PyTorch cap is then not set (see [The cap inside a job](#the-cap-inside-a-job)). Usage is wired pages from `vm_stat`.

saxbyd may start exactly three programs, by absolute path, for this:
`/bin/kill`, `/usr/sbin/sysctl` and `/usr/bin/vm_stat`. It may start
nothing else.

**Linux** is minimal. The probe reads `/proc/meminfo` for usage but
reports no ceiling, because nothing there is one. A GPU card's memory
is separate, and Strix Halo's GPU share is set at boot. **Set
`memory.ceiling_gib` on Linux, or every job is refused.** saxbyd may
start only `/usr/bin/kill` there. That path has not been run on Linux
yet.

Not built yet:

- an NVIDIA probe reading `nvidia-smi`
- an AMD probe reading the `amdgpu` sysfs files, including Strix
  Halo's GTT size
- a Linux limiter that runs the job in a `systemd-run --scope` with
  `MemoryMax`

There is no MLX cap to build: MLX takes its limit from a call, not
the environment, so an MLX job sets it from `SAXBY_RESERVED_BYTES`
(see [The cap inside a job](#the-cap-inside-a-job)).

## Limits

- **Clients that call Ollama directly cannot be gated.** A client
  pointed at Ollama's own port, such as OpenClaw's memory search,
  never passes through Saxby, so it can still load a model while a
  job runs. Its models do count as loaded once they are. Point every
  client at Saxby, which gates its own routes and the inference paths
  it forwards ([Which paths are gated](#which-paths-are-gated)).
- **MLX jobs cap themselves, or not at all.** `saxby reserve` hands
  them the size in `SAXBY_RESERVED_BYTES`; the call is the job's, and
  mflux and mlx-lm do not make it. The call has not yet been run
  under a reservation with a small cap.
  [Issue #34](https://github.com/saxby-tools/saxby/issues/34).
- **An MLX model's growth is not measured.** A model on Ollama's MLX
  runner is counted at the larger of Ollama's number and its
  `size_gib`, never less. What is still not counted is what neither
  knows: the KV cache the runner grows after load, which Ollama does
  not report and the wired-memory probe does not see. A model with no
  `size_gib` is counted at Ollama's number alone. The fix is upstream,
  an honest booked size from Ollama; Saxby inherits it with no change.
  [Issue #45](https://github.com/saxby-tools/saxby/issues/45).
- **Waiters are not in line.** Each waiting job or load checks again
  once a second. A big job can be passed by smaller ones that fit
  sooner. [Issue #35](https://github.com/saxby-tools/saxby/issues/35).
- **Linux is minimal**, as described under Platforms.
  [Issue #36](https://github.com/saxby-tools/saxby/issues/36).
- **Instances do not share a ledger.** A job reserved through the dev
  instance is invisible to the default instance's gate. Reserve
  through the instance your clients use.
  [Issue #37](https://github.com/saxby-tools/saxby/issues/37).
