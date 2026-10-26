#  Releasing

The checklist for cutting a release and for deploying a local build
to the service on this machine. It works by hand the first time and
drifts silently by the third, which is why it is written down.

##  Version

Every package carries the same version. Bump all four together in the
release commit:

```
packages/cli/deno.json
packages/core/deno.json
packages/llm-router/deno.json
packages/vram-guard-mac/deno.json
```

`deno task build` refuses to run if they disagree, so a mixed release
cannot ship. The running daemon reports its version at
`/saxby/v1/status`, and `saxby instance list` shows it.

##  Build

With no argument, this builds `saxbyd` and `saxby` for the machine
you are on. That is all a local deploy needs, and it takes a few
seconds:

```bash
deno task build
```

For a release, build all four targets — darwin-arm64, darwin-x64,
linux-x64 and linux-arm64. CI always does this:

```bash
deno task build all
```

You can also name targets, as in `deno task build linux-x64
linux-arm64`. Each build clears `dist/` first, so name every target
you need in one command. Each target lands in `dist/`:

```
dist/saxby-<version>-<target>/                  staged binaries
dist/saxby-<version>-<target>.tar.gz            + LICENSE, README, completions/
dist/saxby-<version>-<target>.tar.gz.sha256
```

The first build for a target other than your own machine downloads
that target's Deno runtime, about 40 MB, and prints nothing while it
does. It is not stuck.

##  Verify

Check every archive against its checksum. On macOS:

```bash
cd dist && shasum -a 256 -c *.sha256
```

On Linux, use `sha256sum -c` instead. The line format is the same.

Then check the native binary reports the version you expect:

```bash
./dist/saxby-<version>-darwin-arm64/saxbyd --version
```

And that it starts. Run it against the dev instance, never the
default instance your clients use:

```bash
./dist/saxby-<version>-darwin-arm64/saxbyd --instance dev
```

```bash
curl -s http://127.0.0.1:11436/saxby/v1/status
```

##  Deploy to this machine

One command builds this checkout, installs it, restarts the service
and checks the result:

```bash
deno task deploy
```

It does four things, in order:

1. Builds `saxbyd` and `saxby` for this machine.
2. Installs both into `~/.local/bin`, which is user-owned and on
   `PATH` on both macOS and Arch.
3. Restarts the default instance's service with the new `saxby`.
4. Asks the service which version it runs, and fails unless that is
   the version it just built.

The last step is the reason the task exists. Typed by hand, these
steps went stale after a version bump: the install named an old
folder and failed, and the service quietly kept the old build. Now a
deploy either ends with `✅ The service on this machine runs Saxby
<version>` or exits with an error that says what to do.

It deploys the default instance only. The dev instance runs from
source with `deno task dev` and needs no deploy. If the service is not
installed yet, the binaries are still installed and the task tells you
to run `saxby service install`.

A restart does not rewrite the service file. When a release changes
what that file contains — a new environment variable, for example —
run `saxby service install` once after deploying.

###  By hand

The same steps, if you need them. Use `install`, never `cp`:

```bash
install -m 755 dist/saxby-<version>-darwin-arm64/{saxbyd,saxby} ~/.local/bin/
```

```bash
saxby service restart
```

`install` removes the old file and writes a new one, so the running
process keeps the old binary until it restarts. `cp` overwrites the
file the process is running from, which on macOS can get it killed
once its code signature no longer matches the pages on disk.

`saxby instance list` shows the version each running instance
reports, so a stale build is visible at a glance.

##  Release

Releases are built by
[`.github/workflows/release.yml`](../.github/workflows/release.yml) on a
macOS runner, never from a laptop, so every artifact comes from a clean
checkout of a tagged commit.

**Dry run first.** Push the release commit, then open the repository's
Actions tab, pick "release", and click "Run workflow". It runs the
tests, builds all four targets, verifies the checksums, renders the
packaging files, and uploads everything as a workflow artifact named
`saxby-dry-run`. No tag, no release.

**Then tag.** The tag must match the package version, or the workflow
stops before building:

```bash
git tag -a v<version> -m "Saxby v<version>"
```

```bash
git push origin v<version>
```

The workflow opens a **draft** release with the four tarballs, their
`.sha256` files, and the rendered [`PKGBUILD`](../packaging/PKGBUILD)
and [`saxby.rb`](../packaging/saxby.rb). Read it over, then click
Publish. Nothing is public until then.

**Publishing updates the packages.**
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml)
runs when the release is published. It commits the release's
`saxby.rb` to the `saxby-tools/homebrew-tap` tap and pushes its
`PKGBUILD` to `saxby-bin` on the AUR, after building and installing
that package in an Arch container. It also publishes the four
`@saxby` packages to JSR from the tagged commit, signing in with
GitHub's OIDC token, which works only for packages linked to this
repository on jsr.io.

Plain `vX.Y.Z` tags publish, `v0.9.x` included. A tag with a suffix,
such as `v1.0.0-rc.1`, publishes nothing. It needs two repository
secrets:
`HOMEBREW_TAP_DEPLOY_KEY`, a deploy key with write access to the tap,
and `AUR_SSH_KEY`, the key registered with the AUR account.

##  Packaging

None of the templates in `packaging/` is edited by hand per release.

[`PKGBUILD`](../packaging/PKGBUILD) (AUR `saxby-bin`) and
[`saxby.rb`](../packaging/saxby.rb) (Homebrew) carry `@VERSION@` and
`@SHA256_<TARGET>@` tokens. `deno task package` fills them from the
checksums in `dist/` and never writes a file with a token left in it.
The `PKGBUILD` needs both Linux builds; the formula needs all four. With
a partial build, it renders what it can and names what it skipped.
`deno task package all` fails instead, which is what the workflow runs
before attaching the results to the draft release.

[`nfpm.yaml`](../packaging/nfpm.yaml) builds `.deb` and `.rpm` packages
and reads its version, architecture and staged directory from the
environment. Its header shows the command. It is not run in CI.

##  Known caveats

**Compiled binaries run with legacy `request.signal` semantics.**
`deno compile` ignores the `unstable` list in
[`deno.json`](../deno.json), and an explicit
`--unstable-no-legacy-abort` is accepted but has no effect in the binary
(checked on Deno 2.9.6). Under legacy semantics the signal also fires
after a response has been fully delivered. In
[`chat.js`](../packages/llm-router/src/routes/v1/chat.js) that is after
the upstream stream has ended, so it changes nothing. Checked again on
Deno 2.9.8 against a fake backend: a compiled binary and `deno run`
both log a stream read to the end as `completed`, and one the client
cut off mid-stream as `aborted`, with its first-byte time and
duration. (Before v0.9.3, both builds left that cut-off row open
instead.) The binary prints one warning about it at boot. Recheck this
when upgrading Deno, since the new behavior is meant to become the
default.

**macOS quarantines downloaded archives.** A tarball downloaded
through a browser gets a quarantine attribute, and Gatekeeper blocks
the unsigned binaries inside. Local builds are not affected. Signing
and notarization are not set up.
