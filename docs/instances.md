#  Instances

An instance is one shuntd with its own config, its own decision log
and its own cached exemplar vectors. Run several side by side and
none of them sees the others' data.

The usual pair is production and development. Production answers
your clients on `:11435`. A `dev` instance runs the code you are
changing on its own port, and its traffic never lands in the
production log.

##  Why isolation is total

The decision log is the point of shuntd. Threshold calibration and
exemplar tuning are only as good as the rows they read. If dev
traffic landed beside production rows, it would quietly skew that
data, with nothing to tell the two apart later. So an instance shares
nothing: not config, not the log, not the vectors.

##  Where instances live

```
~/.config/shuntd/              the default instance
├── config.jsonc
├── decision-log.db
└── instances/
    └── dev/                   a named instance
        ├── config.jsonc
        └── decision-log.db
```

The default instance is the config folder itself, which is where
shuntd kept everything before instances existed. An older install
needs no migration. A named instance lives in `instances/<name>/`.

If `XDG_CONFIG_HOME` is set, it replaces `~/.config`.

Exemplar vectors are stored inside the decision log, so they move
with it. The first boot of a new instance embeds its exemplars from
scratch. Expect a few seconds and a line such as `embedded 33,
reused 0`. That is not a bug.

**Leave `log_path` unset in a named instance's config.** The log
defaults to the instance's own folder. Setting `log_path` points the
instance at whatever file you name, and if that is production's log,
the isolation is gone. `shunt config generate` never writes it.

##  Naming an instance

Names use lowercase letters, digits and hyphens, and start with a
letter or digit: `dev`, `bge-m3`, `2`. One name becomes a folder, a
launchd label and a systemd unit, which is why the alphabet is
narrow. A dot would make the launchd label ambiguous, and a leading
hyphen reads as a flag.

`default` is reserved. It would create `instances/default/`, a second
"default" that is not the real one. To use the default instance, give
no name at all.

##  Choosing an instance

Every `shunt` command takes `-i <name>` or `--instance <name>`,
before or after the command:

```bash
shunt -i dev config generate
```

```bash
shunt config generate -i dev
```

The daemon takes the same flag, as `--instance <name>`,
`--instance=<name>` or `-i <name>`. Service files pass it as an
argument, so `ps` shows which instance a process serves.

Without a flag, both read `SHUNTD_INSTANCE`. With neither, they use
the default instance. The flag always wins.

A misspelled name fails instead of creating anything. Only
`shunt config generate` creates an instance folder, so `-i dve` stops
with "No config found" and leaves no empty instance behind.

##  Creating one

```bash
shunt -i dev config generate
```

For a named instance, the port prompt suggests `11436` instead of
`11435`, so accepting the default does not collide with production.
Pick another port for a third instance.

To make an instance route exactly like production, copy production's
config into its folder and change `listen_port`. A freshly generated
config lacks any exemplars you added by hand.

##  Seeing them all

```bash
shunt instance list
```

```
NAME     PORT   STATE    PID    VERSION  SERVICE    DIRECTORY
default  11435  running  13995  0.1.0    installed  ~/.config/shuntd
dev      11436  running  80797  0.1.0    -          ~/.config/shuntd/instances/dev
```

STATE is one of four values:

| State | Meaning |
| --- | --- |
| `running` | The shuntd on this port says it is this instance |
| `stopped` | Nothing holds this port; this instance can start |
| `blocked` | Another instance, or a program that is not shuntd, holds this port; this one cannot start |
| `error` | Config missing or invalid; the reason prints below the table |

SERVICE shows whether a user service is installed for the instance.
See `docs/services.md`.

The list asks each port who is there through `GET /shuntd/v1/status`,
which answers from memory with the instance name, port, pid and
version:

```bash
curl -s http://127.0.0.1:11436/shuntd/v1/status
```

```json
{"instance":"dev","port":11436,"pid":80797,"version":"0.1.0"}
```

`instance` is `null` for the default instance.

##  When two instances want one port

Each instance's config sets its own `listen_port`, and nothing stops
two configs from naming the same one. The second shuntd to start
fails, and says which instance is in the way:

```
❌ Port 11436 is already in use.
   It is held by shuntd instance 'dev' (pid 80797).
```

If the holder is the same instance, the usual cause is a second
supervisor — `brew services`, `shunt service`, or a dev run left
open — and the message says so. If the holder is not shuntd at all,
the message says that too, and names the instance folder whose
`listen_port` to change.

##  Probing one

`shunt probe` scores prompts against one instance's Tier 3
exemplars without generating a token:

```bash
shunt -i dev probe "the loop runs one too many times"
```

It refuses to run if the port answers as a different instance, so it
never scores the wrong instance's exemplars.

##  Removing one

There is no command for it. Uninstall its service first, if it has
one, then delete its folder:

```bash
shunt -i dev service uninstall
```

```bash
rm -r ~/.config/shuntd/instances/dev
```

That deletes the instance's decision log along with its config.
