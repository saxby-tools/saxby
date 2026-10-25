//  =====================================================================
//  deno task build
//  =====================================================================
//  Cross-compiles shuntd and shunt, then packs one tarball per target
//  with a .sha256 beside it:
//
//    dist/shuntd-<version>-<target>/          staged, ready to deploy
//    dist/shuntd-<version>-<target>.tar.gz
//    dist/shuntd-<version>-<target>.tar.gz.sha256
//
//  Which targets:
//
//    deno task build                   this machine only
//    deno task build linux-x64 ...     the named targets
//    deno task build all               all four, for a release
//
//  No argument means the host, since one native build is what a local
//  deploy needs. CI always says `all`, so a release never depends
//  on what the runner happens to be.
//
//  Permissions are baked in explicitly rather than -A. The daemon
//  faces the network and never starts a process, so it gets no
//  --allow-run: a bug in request handling cannot launch a program.
//  The CLI runs osascript, launchctl, systemctl and sysctl, so it
//  does, and reads the uid to address the user's launchd domain.
//
//  `deno compile` IGNORES the "unstable" list in deno.json, and an
//  explicit --unstable-no-legacy-abort is accepted but has no effect
//  in the binary (Deno 2.9.6). Compiled binaries therefore run with
//  legacy request.signal semantics. See docs/releasing.md.

import { basename, join } from "@std/path";
import { readLockstepVersion } from "./version.js";

const DIST_DIR = "dist";
const ARCHIVE_PREFIX = "shuntd";

const ALL_KEYWORD = "all";

//  os and arch use Deno.build's names, so the host can be matched.
const TARGETS = [
    {
        name: "darwin-arm64",
        triple: "aarch64-apple-darwin",
        os: "darwin",
        arch: "aarch64",
    },
    {
        name: "darwin-x64",
        triple: "x86_64-apple-darwin",
        os: "darwin",
        arch: "x86_64",
    },
    {
        name: "linux-x64",
        triple: "x86_64-unknown-linux-gnu",
        os: "linux",
        arch: "x86_64",
    },
    {
        name: "linux-arm64",
        triple: "aarch64-unknown-linux-gnu",
        os: "linux",
        arch: "aarch64",
    },
];

const BINARIES = [
    {
        name: "shuntd",
        entry: "packages/llm-router/src/main.js",
        permissions: [
            "--allow-net",
            "--allow-env",
            "--allow-read",
            "--allow-write",
        ],
        include: [],
    },
    {
        name: "shunt",
        entry: "packages/cli/src/main.js",
        permissions: [
            "--allow-net",
            "--allow-env",
            "--allow-read",
            "--allow-write",
            "--allow-run",
            "--allow-sys=uid",
        ],
        include: ["packages/vram-mac-guard/src/vram-mac-guard.sh"],
    },
];

const EXTRA_FILES = ["LICENSE", "README.md"];

function knownNames() {
    return TARGETS.map((target) => target.name).join(", ");
}

function hostTarget() {
    const host = TARGETS.find((target) =>
        target.os === Deno.build.os && target.arch === Deno.build.arch
    );

    if (!host) {
        throw new Error(
            `No target for this machine (${Deno.build.os} ` +
                `${Deno.build.arch}). Name one: ${knownNames()}`,
        );
    }

    return host;
}

function selectNamed(names) {
    const known = new Set(TARGETS.map((target) => target.name));

    for (const name of names) {
        if (!known.has(name)) {
            throw new Error(
                `Unknown target '${name}'. Known: ${knownNames()}`,
            );
        }
    }

    return TARGETS.filter((target) => names.includes(target.name));
}

function selectTargets(names) {
    if (names.length === 0) {
        return [hostTarget()];
    }

    if (!names.includes(ALL_KEYWORD)) {
        return selectNamed(names);
    }

    if (names.length > 1) {
        throw new Error(`'${ALL_KEYWORD}' cannot be combined with targets.`);
    }

    return TARGETS;
}

async function run(command, args, env = {}) {
    const child = new Deno.Command(command, {
        args,
        env,
        stdout: "inherit",
        stderr: "inherit",
    });

    const { code } = await child.output();

    if (code !== 0) {
        throw new Error(`${command} ${args.join(" ")} exited ${code}`);
    }
}

async function compile(binary, target, outDir) {
    const includes = binary.include.flatMap((path) => ["--include", path]);

    await run("deno", [
        "compile",
        "--quiet",
        "--target",
        target.triple,
        ...binary.permissions,
        ...includes,
        "--output",
        join(outDir, binary.name),
        binary.entry,
    ]);
}

async function sha256Hex(path) {
    const bytes = await Deno.readFile(path);
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

//  Same line format as `shasum -a 256` and `sha256sum`, so either
//  tool can check it with -c from inside dist/.
async function writeChecksum(archivePath) {
    const hex = await sha256Hex(archivePath);
    const line = `${hex}  ${basename(archivePath)}\n`;

    await Deno.writeTextFile(`${archivePath}.sha256`, line);
}

//  --no-xattrs plus COPYFILE_DISABLE keep macOS metadata (._ files,
//  quarantine attributes) out of an archive Linux will unpack.
async function pack(stageName) {
    const archivePath = join(DIST_DIR, `${stageName}.tar.gz`);

    await run(
        "tar",
        ["--no-xattrs", "-czf", archivePath, "-C", DIST_DIR, stageName],
        { COPYFILE_DISABLE: "1" },
    );

    await writeChecksum(archivePath);

    return archivePath;
}

async function buildTarget(target, version) {
    const stageName = `${ARCHIVE_PREFIX}-${version}-${target.name}`;
    const stageDir = join(DIST_DIR, stageName);

    await Deno.mkdir(stageDir, { recursive: true });

    for (const binary of BINARIES) {
        console.log(`🔨 ${target.name}: ${binary.name}`);
        await compile(binary, target, stageDir);
    }

    for (const file of EXTRA_FILES) {
        await Deno.copyFile(file, join(stageDir, file));
    }

    const archivePath = await pack(stageName);

    console.log(`📦 ${archivePath}`);

    return stageDir;
}

/**
 * Builds the named targets, or this machine's alone when none are
 * named. Also used by scripts/deploy.js.
 * @param {string[]} names target names, or ["all"]
 * @returns {Promise<{version: string, stageDirs: string[]}>}
 */
export async function build(names) {
    const version = await readLockstepVersion();
    const targets = selectTargets(names);
    const stageDirs = [];

    await Deno.remove(DIST_DIR, { recursive: true }).catch(() => {});
    await Deno.mkdir(DIST_DIR);

    console.log(`shuntd ${version}, ${targets.length} target(s)\n`);

    for (const target of targets) {
        stageDirs.push(await buildTarget(target, version));
    }

    return { version, stageDirs };
}

async function main() {
    await build(Deno.args);
}

//  Script errors are user errors here — a missing build, mismatched
//  versions — so print the message, not a stack trace.
if (import.meta.main) {
    try {
        await main();
    } catch (err) {
        console.error(`❌ ${err.message}`);
        Deno.exit(1);
    }
}
