//  =====================================================================
//  saxby token — the API token clients on other machines need
//  =====================================================================
//  saxbyd asks for the token from every request that does not come
//  straight from the machine it runs on (core's config/token.js says
//  why). This prints it, so it can be pasted into a client, and
//  replaces it.
//
//  Only the token goes to stdout, so `saxby token | pbcopy` copies
//  the token and nothing else. Everything said to a person goes to
//  stderr.

import { Command } from "@cliffy/command";
import {
    generateApiToken,
    getInstanceDir,
    instancePhrase,
    isWeakApiToken,
    readOrCreateApiToken,
    resolveInstanceName,
    writeApiToken,
} from "@saxby/core";

const EXIT_FAILURE = 1;

//  The token belongs to an instance that exists. Writing one for a
//  mistyped name would print a token no saxbyd holds.
async function resolveDir(options) {
    const instance = resolveInstanceName(options.instance);
    const dir = getInstanceDir(instance);

    try {
        await Deno.stat(dir);
    } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
            throw err;
        }

        throw new Error(
            `No config folder for ${instancePhrase(instance)} at ` +
                `${dir}. Run 'saxby config generate' for it first.`,
        );
    }

    return { instance, dir };
}

function fail(error) {
    console.error(`❌ ${error.message}`);
    Deno.exit(EXIT_FAILURE);
}

async function show(options) {
    try {
        const { instance, dir } = await resolveDir(options);
        const found = await readOrCreateApiToken(dir);

        if (found.created) {
            console.error(
                `🔑 No token yet for ${instancePhrase(instance)}; wrote ` +
                    `one to ${found.path}`,
            );
        }

        if (isWeakApiToken(found.token)) {
            console.error(
                `⚠️  This token is ${found.token.length} characters ` +
                    `long, short enough to guess. 'saxby token rotate' ` +
                    `writes a strong one.`,
            );
        }

        console.log(found.token);
    } catch (error) {
        fail(error);
    }
}

async function rotate(options) {
    try {
        const { instance, dir } = await resolveDir(options);
        const token = generateApiToken();
        const path = await writeApiToken(dir, token);

        console.error(
            `🔑 New token for ${instancePhrase(instance)} written to ` +
                `${path}\n` +
                `   saxbyd reads it at boot: restart it, then give ` +
                `every client on another machine the new token.`,
        );

        console.log(token);
    } catch (error) {
        fail(error);
    }
}

const rotateCommand = new Command()
    .description(
        "Replace the API token with a new random one. Restart saxbyd after.",
    )
    .action(rotate);

/**
 * `saxby token`: prints this instance's API token to stdout and
 * nothing else there, so it pipes into a clipboard. Writes one first
 * if none exists, and warns on stderr when it is short enough to
 * guess. `saxby token rotate` replaces it.
 */
export const tokenCommand = new Command()
    .description(
        "Print the API token that clients on other machines must send.",
    )
    .action(show)
    .command("rotate", rotateCommand);
