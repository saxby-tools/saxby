//  =====================================================================
//  Instances
//  =====================================================================
//  An instance is a folder holding its own config, decision log and
//  exemplar vectors. Isolation is total because the decision log is
//  the point: dev traffic beside the rows of your production instance
//  would corrupt the data that threshold calibration depends on.
//
//  No name resolves to the config root itself, so installs from
//  before instances existed need no migration. A name resolves to
//  instances/<name>/ under it.
//
//  One name becomes a folder, a launchd label suffix and a systemd
//  unit suffix, hence the narrow alphabet: a dot would make the label
//  ambiguous, and a leading hyphen reads as a flag.

import { join } from "@std/path";
import { getConfigDir } from "../utils/env.js";

const SAXBY_DIR_NAME = "saxby";
const INSTANCES_DIR_NAME = "instances";
const INSTANCE_ENV = "SAXBY_INSTANCE";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

//  `default` names the default instance, which lives at the config
//  root. As a folder it would be instances/default/, a second
//  "default" that is not the real one, so it is never a folder name.
const DEFAULT_LABEL = "default";
const RESERVED_NAMES = new Set([DEFAULT_LABEL]);

/**
 * Throws unless the name is safe as a folder, label and unit suffix.
 * @param {string} name
 * @returns {string} The same name, for chaining.
 */
export function validateInstanceName(name) {
    if (!NAME_PATTERN.test(name)) {
        throw new Error(
            `Invalid instance name '${name}': use lowercase letters, ` +
                `digits and hyphens, starting with a letter or digit.`,
        );
    }

    if (RESERVED_NAMES.has(name)) {
        throw new Error(
            `Instance name '${name}' is reserved for the default ` +
                `instance and is never a folder name.`,
        );
    }

    return name;
}

/**
 * The directory holding an instance's config, log and vectors.
 * @param {string | null} name - A name from resolveInstanceName.
 * @returns {string}
 */
export function getInstanceDir(name = null) {
    const root = join(getConfigDir(), SAXBY_DIR_NAME);

    if (!name) {
        return root;
    }

    return join(root, INSTANCES_DIR_NAME, validateInstanceName(name));
}

//  `default` always means the default instance. Asking for it by name
//  is not an error, but it never becomes a folder, so say where the
//  request went.
function readRequestedName(name) {
    if (name === DEFAULT_LABEL) {
        console.warn(
            `ℹ️  '${DEFAULT_LABEL}' is reserved for the default instance. ` +
                `Using ${getInstanceDir(null)}.`,
        );
        return null;
    }

    return validateInstanceName(name);
}

/**
 * Resolves the instance name: the flag wins, then SAXBY_INSTANCE,
 * then none. The ONLY place the environment variable is read.
 * @param {string | undefined} flag - Value of --instance, if given.
 * @returns {string | null} A validated name, or null for the default.
 */
export function resolveInstanceName(flag) {
    if (flag) {
        return readRequestedName(flag);
    }

    const fromEnv = Deno.env.get(INSTANCE_ENV);

    if (fromEnv) {
        return readRequestedName(fromEnv);
    }

    return null;
}

/**
 * The short name shown in tables and labelled fields: the instance's
 * own name, or "default".
 * @param {string | null} name - A name from resolveInstanceName.
 * @returns {string}
 */
export function instanceLabel(name) {
    return name ?? DEFAULT_LABEL;
}

/**
 * How every message names an instance in a sentence: "the default
 * instance", "the dev instance". The docs use the same words, so
 * output and docs never drift apart.
 * @param {string | null} name - A name from resolveInstanceName.
 * @returns {string}
 */
export function instancePhrase(name) {
    return `the ${instanceLabel(name)} instance`;
}

function isValidInstanceName(name) {
    if (!NAME_PATTERN.test(name)) {
        return false;
    }

    if (RESERVED_NAMES.has(name)) {
        return false;
    }

    return true;
}

/**
 * Every instance: the default (null) first, then named instances that
 * have a directory, sorted. Folders with invalid names are skipped,
 * since saxby could not have created them.
 * @returns {Promise<(string | null)[]>}
 */
export async function listInstances() {
    const instancesDir = join(getInstanceDir(null), INSTANCES_DIR_NAME);
    const named = [];

    let entries = [];

    try {
        entries = await Array.fromAsync(Deno.readDir(instancesDir));
    } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
            throw err;
        }
    }

    for (const entry of entries) {
        if (!entry.isDirectory) {
            continue;
        }

        if (!isValidInstanceName(entry.name)) {
            continue;
        }

        named.push(entry.name);
    }

    return [null, ...named.sort()];
}
