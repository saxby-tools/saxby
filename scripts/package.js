//  =====================================================================
//  deno task package
//  =====================================================================
//  Fills the packaging templates with this release's version and
//  checksums, read from the .sha256 files `deno task build` wrote:
//
//    packaging/PKGBUILD   ->  dist/packaging/PKGBUILD
//    packaging/shuntd.rb  ->  dist/packaging/shuntd.rb
//
//  Every template carries a version and checksums. Bumped by hand,
//  they drift by the third release; rendered from dist/ they cannot.
//  Needs a full four-target build, and refuses to write a file with
//  any @TOKEN@ left in it.

import { join } from "@std/path";
import { readLockstepVersion } from "./version.js";

const DIST_DIR = "dist";
const OUT_DIR = join(DIST_DIR, "packaging");
const TEMPLATES = ["packaging/PKGBUILD", "packaging/shuntd.rb"];
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const LEFTOVER_TOKEN = /@[A-Z0-9_]+@/;

async function readChecksum(version, target) {
    const path = join(DIST_DIR, `shuntd-${version}-${target}.tar.gz.sha256`);

    let line;

    try {
        line = await Deno.readTextFile(path);
    } catch {
        throw new Error(`${path} is missing. Run 'deno task build' first.`);
    }

    return line.split(/\s+/)[0];
}

//  darwin-arm64 -> SHA256_DARWIN_ARM64
function tokenFor(target) {
    return `SHA256_${target.toUpperCase().replaceAll("-", "_")}`;
}

async function collectValues(version) {
    const values = { VERSION: version };

    for (const target of TARGETS) {
        values[tokenFor(target)] = await readChecksum(version, target);
    }

    return values;
}

function render(text, values) {
    let out = text;

    for (const [key, value] of Object.entries(values)) {
        out = out.replaceAll(`@${key}@`, value);
    }

    return out;
}

async function main() {
    const version = await readLockstepVersion();
    const values = await collectValues(version);

    await Deno.mkdir(OUT_DIR, { recursive: true });

    for (const template of TEMPLATES) {
        const text = render(await Deno.readTextFile(template), values);
        const leftover = text.match(LEFTOVER_TOKEN);

        if (leftover) {
            throw new Error(`${template} still has ${leftover[0]}.`);
        }

        const outPath = join(OUT_DIR, template.split("/").pop());

        await Deno.writeTextFile(outPath, text);
        console.log(`📝 ${outPath}`);
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
