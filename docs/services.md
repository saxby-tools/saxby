#  Services

shuntd runs as a user service: a LaunchAgent on macOS, a
`systemd --user` unit on Linux. It runs as you, reads your config,
and needs no root.

##  Install

The service runs a compiled `shuntd`, never a source checkout. A
service that ran `deno run` from the repository would pick up any
half-finished edit on its next restart. Promote a build first (see
`docs/releasing.md`), then:

```bash
shunt service install
```

Install finds `shuntd` on `PATH` and writes its absolute path into the
service file. Pass `--bin <path>` to choose a different binary. It
refuses to install when another shuntd already answers on the
instance's port, since the new service would only crash-loop against
it. Stop the other one first.

If `XDG_CONFIG_HOME` is set when you install, it is written into the
service so the service reads the same config `shunt` does.

| | macOS | Linux |
| --- | --- | --- |
| Default instance | `org.shuntd.router` | `shuntd.service` |
| Named instance | `org.shuntd.router.<name>` | `shuntd-<name>.service` |
| Service file | `~/Library/LaunchAgents/` | `~/.config/systemd/user/` |
| Logs | `~/Library/Logs/shuntd/` | `journalctl --user -u <unit>` |

On macOS, the first install shows a "Background Items Added"
notification. That is expected.

On Linux, user units stop when you log out unless lingering is on for
your user. On a desktop that is usually what you want. On a headless
box, turn it on yourself with `loginctl enable-linger`.

##  Day to day

```bash
shunt service status
```

```bash
shunt service restart
```

```bash
shunt service uninstall
```

Uninstall removes the service only. Config, the decision log, and log
files stay.

`shunt instance list` shows every instance, whether it is running,
its pid and version, and whether a service is installed for it.

##  Dev and prod

Three ways to run shuntd, each with its own job.

**Production** is the default instance on `:11435`, run by the
service from a promoted binary. Every client points here and stays
pointed here.

**Development** is `deno task dev`. It runs the source tree under
`--watch` as the `dev` instance, on its own port (`:11436` by
convention) with its own config, decision log and exemplar vectors.
Production keeps running and its archive stays clean. Create the dev
instance once:

```bash
shunt -i dev config generate
```

To make dev route exactly like production, copy production's config
into `~/.config/shuntd/instances/dev/` and set `listen_port` back to
the dev port. A freshly generated config lacks any exemplars you added
by hand.

**Dev build against real traffic** is the explicit third mode, for
when a change needs real clients rather than a probe. Stop the
service and run the source tree as the default instance:

```bash
launchctl bootout gui/$(id -u)/org.shuntd.router
```

On Linux, `systemctl --user stop shuntd` does the same.

```bash
deno run -A packages/llm-router/src/main.js --trace
```

That run writes to the production decision log, which is why it
stays a manual step. When done, stop it and bring the service back
with `shunt service install`.
