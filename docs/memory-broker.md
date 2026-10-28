#  Memory broker

Saxby keeps heavy GPU jobs and model loads from overfilling GPU
memory. Put `saxby reserve` in front of a heavy command:

```bash
saxby reserve --gib 12 -- upscayl-bin -i in.png -o out.png
```

The job waits until 12 GiB is free, then runs with PyTorch capped at
12 GiB. It never takes the space of a model you marked as pinned. If
it can't get the memory in time, it is refused with a reason. If
saxbyd can't be asked at all, the job does not run.

While a job holds memory, Saxby also makes chat requests wait before
they load a model that would not fit. With no job running, chat
requests skip the broker entirely.

##  Why it exists

On Oct. 27, 2026, a PyTorch job on a Mac's GPU grew to 122 GiB while
two models held about 40 GiB. On Apple Silicon, GPU memory is
"wired": it cannot be paged out. Wired memory reached 123.7 of
128 GiB, the system froze, and the kernel panicked.

Two things were missing. Nothing kept the job from starting while the
models were loaded, and nothing kept it from growing once it ran. The
broker fixes the first; the PyTorch cap fixes the second.

##  Using it

```
saxby [-i <name>] reserve --gib <N> [--timeout <s>] [--label <text>]
    [--no-broker] -- <command> [args...]
```

| Flag | Meaning |
| --- | --- |
| `--gib` | Required. GPU memory to reserve, in GiB; decimals are fine |
| `--timeout` | Seconds to wait for room. Default: `memory.wait_timeout_s` |
| `--label` | Name in the log. Default: the command's name |
| `--no-broker` | Run without asking saxbyd. Prints a warning |
| `-i` | Ask a named instance's saxbyd instead of the default one |

The `--` is required. Everything after it is the job, passed through
untouched, so the job's own flags are never read as Saxby's.

Messages from `saxby reserve` go to stderr. The job's stdout stays
its own.

Size the reservation to the job's peak, not its average. The PyTorch
cap makes a job that goes over fail with an out-of-memory error.

###  Exit codes

| Code | Meaning |
| --- | --- |
| the job's | The job ran; this is its own exit code |
| 128 + n | The job was killed by signal n (143 for SIGTERM) |
| 2 | A usage error, such as no command after `--` |
| 69 | saxbyd could not be asked, so nothing ran |
| 75 | saxbyd refused: no room within the timeout, or never enough |
| 127 | The command could not be started |
| 130 | You pressed Ctrl-C while it waited; nothing ran |

75 means "try again later." 69 means "the broker is missing." A skill
can retry on the first and should stop on the second.

###  Signals

`SIGTERM` sent to `saxby reserve` is passed on to the job. Ctrl-C in
a terminal already reaches the job, because both share the terminal's
process group, so the wrapper does not pass it on a second time. A
second Ctrl-C can cut a job's own cleanup short.

##  The budget

One formula decides both jobs and model loads:

```
free = ceiling - margin - pinned - loaded - reserved
```

| Term | What it is |
| --- | --- |
| ceiling | The most the GPU may hold. On macOS, `iogpu.wired_limit_mb` |
| margin | Kept free beyond everything else. `memory.margin_gib` |
| pinned | Every pinned model at full size, loaded or not |
| loaded | Every other model the backend holds now |
| reserved | Every job, plus model loads let through but not yet loaded |

A job of N GiB runs when N fits in `free`.

**Pinned models count even when they are not loaded.** That is what
"a job never takes a pinned model's space" means. If a pinned model
has unloaded, its space is still held for it.

**Other loaded models count too.** A job cannot evict a model, so a
model loaded for one request holds its space until the backend
unloads it. That includes models loaded straight through Ollama, by
clients that skip Saxby.

**A request that can never fit is refused at once.** If N is more
than the ceiling minus the margin and the pinned models, waiting
would not help, so there is no wait.

**An unknown is never free memory.** If any term cannot be known,
nothing is admitted. The refusal says which term:

- the ceiling cannot be measured (see [Platforms](#platforms))
- the backend did not answer `/api/ps`
- a pinned model has no known size

The current budget, in bytes:

```bash
curl -s http://127.0.0.1:11435/saxby/v1/reservations
```

##  Pinned models

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
2. what the backend reported the last time it was loaded
3. `size_gib` in the config

Sizes from the backend are kept in the decision log's file, so a
saxbyd restart does not forget them. If none of the three exists, the
size is unknown, and **every job is refused until it is known**. The
boot log says so:

```
🧮 Memory broker: ceiling 96.0 GiB (iogpu.wired_limit_mb), margin 8.0 GiB
   pinned: gemma4:31b (size unknown), granite4:micro-h 4.5 GiB (size_gib)
⚠️  Jobs will be refused until this is fixed: pinned model 'gemma4:31b' has no known size; load it once or give it size_gib
```

That fixes itself the first time the model loads. Set `size_gib` to
skip the wait. A measured size always beats `size_gib`, since the
real size changes with the context length the backend loads.

##  Model loads

Ollama decides whether a model fits by looking at memory that is free
right now. A job that has reserved 40 GiB but not used it yet looks
free. So while a job holds a reservation, Saxby checks each chat
request before it is sent to the backend:

- **No job held:** not checked. No call to the backend, no wait.
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

A model's size comes from the backend's last report or the catalog's
`size_gib`. A model with neither waits until no job is held.

`saxby/<model>` bypass requests and raw model names are checked the
same way. They load models too.

Once a load is let through, its size is held in the ledger until the
response's first byte arrives. By then the backend lists the model,
and its size counts as loaded. Without the hold, two different models
could both be let through into the same free space.

The decision-log row of a refused request has the outcome
`memory_refused`. Its `request_id` matches a row in `memory_events`
that says why.

##  Reservations end with their process

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

##  The cap inside a job

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

**MLX jobs are not capped.** MLX reads neither variable. The ledger
still counts an MLX job, so it cannot start beside models it would
not fit with. It can still grow past its reservation once it runs.

##  When saxbyd cannot be asked

The broker fails closed. `saxby reserve` refuses to run the job, and
exits 69, when:

- saxbyd does not answer on the instance's port
- the instance has no config, so there is no port to ask
- saxbyd answers but has no broker (a saxbyd older than the CLI)

`--no-broker` runs the job anyway. It prints a warning and still sets
the PyTorch cap if it can read the ceiling itself. The job is
invisible to saxbyd: model loads will not wait for it.

##  Config

```jsonc
"memory": {
    "margin_gib": 8,
    "wait_timeout_s": 120,
    "heartbeat_interval_s": 10
}
```

The whole section is optional. The broker is always on.

| Field | Default | Meaning |
| --- | --- | --- |
| `margin_gib` | `8` | Kept free beyond every model and job |
| `wait_timeout_s` | `120` | How long a job or model load waits for room |
| `heartbeat_interval_s` | `10` | How often wrappers check in and dead jobs are reaped |
| `ceiling_gib` | none | The ceiling, used only when it can't be measured |

**The margin** is room for what the budget cannot see: memory the
kernel wires for itself, and a model whose real size has drifted from
its last report. Every log row stores the wired memory the system
observed beside the budget, so the margin can be tuned against
evidence later.

**The wait** is long enough for a short job ahead to finish. It
applies to chat requests too, so a client waits this long before it
gets a 503.

**The heartbeat** sets how long a dead job's memory stays held: at
most one interval.

**`ceiling_gib`** fills in only when the probe cannot measure the
ceiling. A measured ceiling always wins. Set it to the GPU's real
maximum; a guess that is too high lets the broker overfill the GPU.

##  The API

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
    "waited_ms": 0
}
```

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

##  The log

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

##  Platforms

Each platform's code sits behind a small adapter, like the service
and backend adapters.

**macOS on Apple Silicon** is complete. The ceiling is
`iogpu.wired_limit_mb`, which `saxby vram-guard-mac` sets. When it is
0, macOS uses its own default, and only Metal reports that. Ollama
logs it but has no API for it, so the broker calls the ceiling
unknown and uses `memory.ceiling_gib`. Usage is wired pages from
`vm_stat`.

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
- an MLX cap

##  Limits

- **Only Saxby's chat route is gated.** Clients that call Ollama
  directly, and Ollama's native paths sent through Saxby's catch-all
  (`/api/chat`, `/api/generate`, `/api/embed`, `/v1/embeddings`,
  `/v1/completions`), can still load a model while a job runs. Their
  models do count as loaded once they are.
  [Issue #33](https://github.com/saxby-tools/saxby/issues/33).
- **MLX jobs are not capped** once they run.
  [Issue #34](https://github.com/saxby-tools/saxby/issues/34).
- **Waiters are not in line.** Each waiting job or load checks again
  once a second. A big job can be passed by smaller ones that fit
  sooner. [Issue #35](https://github.com/saxby-tools/saxby/issues/35).
- **Linux is minimal**, as described under Platforms.
  [Issue #36](https://github.com/saxby-tools/saxby/issues/36).
- **Instances do not share a ledger.** A job reserved through the dev
  instance is invisible to the default instance's gate. Reserve
  through the instance your clients use.
  [Issue #37](https://github.com/saxby-tools/saxby/issues/37).
- **`explain` does not show the gate.** It never calls the backend,
  and the gate reads `/api/ps`.
  [Issue #38](https://github.com/saxby-tools/saxby/issues/38).
