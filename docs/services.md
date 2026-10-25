#  Services

Saxby runs as a user service: a LaunchAgent on macOS, a
`systemd --user` unit on Linux. It runs as you, reads your config,
and needs no root.

##  Install

The service runs a compiled `saxbyd`, never a source checkout. A
service that ran `deno run` from the repository would pick up any
half-finished edit on its next restart. Deploy a build first (see
[Releasing](releasing.md)), then:

```bash
saxby service install
```

Install finds `saxbyd` on `PATH` and writes its absolute path into the
service file. Pass `--bin <path>` to choose a different binary. It
refuses to install when something else already holds the instance's
port — another saxbyd, or a program that is not saxbyd — since the
new service would only crash-loop against it. Stop the other one
first.

If `XDG_CONFIG_HOME` is set when you install, it is written into the
service so the service reads the same config `saxby` does. Every
service also gets `NO_COLOR=1`, which keeps terminal color codes out
of its log.

| | macOS | Linux |
| --- | --- | --- |
| Default instance | `tools.saxby.router` | `saxbyd.service` |
| Named instance | `tools.saxby.router.<name>` | `saxbyd-<name>.service` |
| Service file | `~/Library/LaunchAgents/` | `~/.config/systemd/user/` |
| Logs | `~/Library/Logs/saxby/` | `journalctl --user -u <unit>` |

On macOS, the first install shows a "Background Items Added"
notification. That is expected.

On Linux, user units stop when you log out unless lingering is on for
your user. On a desktop that is usually what you want. On a headless
box, turn it on yourself with `loginctl enable-linger`.

##  Day to day

```bash
saxby service status
```

```bash
saxby service restart
```

```bash
saxby service uninstall
```

Uninstall removes the service only. Config, the decision log, and log
files stay.

`saxby instance list` shows every instance, whether it is running,
its pid and version, and whether a service is installed for it.

##  The default instance and the dev instance

Three ways to run Saxby, each with its own job.

**The default instance** is the one your clients use, on `:11435`, run
by the service from a deployed binary. Every client points here and
stays pointed here.

**The dev instance** runs the source tree with `deno task dev`, under
`--watch`, on its own port (`:11436` by convention) with its own
config, decision log and exemplar vectors. The default instance keeps
running and its archive stays clean. Create the dev instance once:

```bash
saxby -i dev config generate
```

To make the dev instance route exactly like the default instance, copy
`~/.config/saxby/config.jsonc` into `~/.config/saxby/instances/dev/`
and set `listen_port` back to the dev instance's port. A freshly
generated config lacks any exemplars you added by hand. Leave
`log_path` unset in the copy, or the dev instance writes wherever it
points (see [Instances](instances.md)).

**The source tree as the default instance** is the explicit third
mode, for when a change needs real clients rather than a probe. Stop
the service and run the source tree as the default instance:

```bash
launchctl bootout gui/$(id -u)/tools.saxby.router
```

On Linux, `systemctl --user stop saxbyd` does the same.

```bash
deno run -A packages/llm-router/src/main.js --trace
```

That run writes to the default instance's decision log, which is why
it stays a manual step. When done, stop it and bring the service back
with `saxby service install`.

##  Backend environment

Saxby does not set the backend's environment. Ollama runs under its
own supervisor, and whatever starts a process owns its environment.
Variables such as `OLLAMA_MAX_LOADED_MODELS` and `OLLAMA_KEEP_ALIVE`
belong there.

###  macOS with Homebrew

Editing Homebrew's plist does not stick. `brew services start`
regenerates `~/Library/LaunchAgents/sh.brew.ollama.plist` (or the
legacy `homebrew.mxcl.ollama.plist`) from the formula every time,
and `restart` and upgrades do the same. A login agent that runs
`launchctl setenv` does not fix it either: it and Ollama's agent
start in no fixed order, so after a reboot the variables may or may
not arrive.

The reliable fix is to let your own LaunchAgent start Ollama. Stop
the Homebrew service first:

```bash
brew services stop ollama
```

Save this as `~/Library/LaunchAgents/local.ollama.plist`, with your
own variables. Homebrew's formula sets `OLLAMA_FLASH_ATTENTION` and
`OLLAMA_KV_CACHE_TYPE`; carry them over if you want to keep them.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
    "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>local.ollama</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/opt/ollama/bin/ollama</string>
        <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>OLLAMA_FLASH_ATTENTION</key>
        <string>1</string>
        <key>OLLAMA_KV_CACHE_TYPE</key>
        <string>q8_0</string>
        <key>OLLAMA_MAX_LOADED_MODELS</key>
        <string>3</string>
        <key>OLLAMA_KEEP_ALIVE</key>
        <string>-1</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/opt/homebrew/var/log/ollama.log</string>
    <key>StandardErrorPath</key>
    <string>/opt/homebrew/var/log/ollama.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.ollama.plist
```

The `opt` path survives `brew upgrade`, but Homebrew no longer
restarts Ollama for you. After an upgrade, restart it yourself:

```bash
launchctl kickstart -k gui/$(id -u)/local.ollama
```

###  macOS with Ollama.app

`launchctl setenv` followed by restarting the app works until the
next reboot, then the variables are gone. For settings that must
survive a reboot, use the LaunchAgent above instead of the app.

###  Linux

Ollama's installer sets it up as a system unit, which a
`systemd --user` service cannot reach. Add a drop-in instead:

```bash
sudo systemctl edit ollama.service
```

Put the variables under a `[Service]` header:

```ini
[Service]
Environment="OLLAMA_MAX_LOADED_MODELS=3"
Environment="OLLAMA_KEEP_ALIVE=-1"
```

Then restart Ollama. The drop-in survives package upgrades.

```bash
sudo systemctl restart ollama
```
