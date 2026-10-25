//  =====================================================================
//  deno task package
//  =====================================================================
//  Fills the packaging templates with this release's version and
//  checksums, read from the .sha256 files `deno task build` wrote:
//
//    packaging/PKGBUILD   ->  dist/packaging/PKGBUILD    (both linux)
//    packaging/saxby.rb   ->  dist/packaging/saxby.rb    (all four)
//
//  Every template carries a version and checksums. Bumped by hand,
//  they drift by the third release; rendered from dist/ they cannot.
//
//    deno task package       render what this build can fill, and
//                            name every template it had to skip
//    deno task package all   every template or fail — what CI runs,
//                            so a release cannot quietly lack one
//
//  Never writes a file with any @TOKEN@ left in it.

import { join } from "@std/path";
import { readLockstepVersion } from "./version.js";

const DIST_DIR = "dist";
const OUT_DIR = join(DIST_DIR, "packaging");
const ALL_KEYWORD = "all";
const LEFTOVER_TOKEN = /@[A-Z0-9_]+@/;

//  One PKGBUILD serves both Linux arches, so it needs both builds.
const TEMPLATES = [
    {
        path: "packaging/PKGBUILD",
        targets: ["linux-x64", "linux-arm64"],
    },
    {
        path: "packaging/saxby.rb",
        targets: ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"],
    },
];

function readMode(args) {
    if (args.length === 0) {
        return { strict: false };
    }

    if (args.length === 1 && args[0] === ALL_KEYWORD) {
        return { strict: true };
    }

    throw new Error(`Expected no argument or '${ALL_KEYWORD}'.`);
}

function checksumPath(version, target) {
    return join(DIST_DIR, `saxby-${version}-${target}.tar.gz.sha256`);
}

//  null when that target was not built.
async function readChecksum(version, target) {
    let line;

    try {
        line = await Deno.readTextFile(checksumPath(version, target));
    } catch {
        return null;
    }

    return line.split(/\s+/)[0];
}

//  darwin-arm64 -> SHA256_DARWIN_ARM64
function tokenFor(target) {
    return `SHA256_${target.toUpperCase().replaceAll("-", "_")}`;
}

async function collectChecksums(version) {
    const names = new Set(TEMPLATES.flatMap((template) => template.targets));
    const checksums = new Map();

    for (const target of names) {
        const hex = await readChecksum(version, target);

        if (hex) {
            checksums.set(target, hex);
        }
    }

    return checksums;
}

function render(text, values) {
    let out = text;

    for (const [key, value] of Object.entries(values)) {
        out = out.replaceAll(`@${key}@`, value);
    }

    return out;
}

async function renderTemplate(template, version, checksums) {
    const values = { VERSION: version };

    for (const target of template.targets) {
        values[tokenFor(target)] = checksums.get(target);
    }

    const text = render(await Deno.readTextFile(template.path), values);
    const leftover = text.match(LEFTOVER_TOKEN);

    if (leftover) {
        throw new Error(`${template.path} still has ${leftover[0]}.`);
    }

    const outPath = join(OUT_DIR, template.path.split("/").pop());

    await Deno.writeTextFile(outPath, text);

    return outPath;
}

async function main() {
    const { strict } = readMode(Deno.args);
    const version = await readLockstepVersion();
    const checksums = await collectChecksums(version);

    const plan = TEMPLATES.map((template) => ({
        template,
        missing: template.targets.filter((t) => !checksums.has(t)),
    }));

    //  Strict checks everything before writing anything, so a failed
    //  release run leaves no half-rendered set behind.
    for (const { template, missing } of plan) {
        if (missing.length > 0 && strict) {
            throw new Error(
                `${template.path} needs ${missing.join(", ")}. ` +
                    `Run 'deno task build ${ALL_KEYWORD}' first.`,
            );
        }
    }

    await Deno.mkdir(OUT_DIR, { recursive: true });

    let rendered = 0;

    for (const { template, missing } of plan) {
        if (missing.length > 0) {
            console.log(
                `⏭️  ${template.path} skipped: needs ` +
                    `${missing.join(", ")}`,
            );
            continue;
        }

        const outPath = await renderTemplate(template, version, checksums);

        console.log(`📝 ${outPath}`);
        rendered++;
    }

    if (rendered === 0) {
        throw new Error("Nothing rendered. Build the targets named above.");
    }
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
