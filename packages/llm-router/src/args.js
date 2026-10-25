//  =====================================================================
//  Daemon arguments
//  =====================================================================
//  The daemon takes a handful of flags, so they are read by hand
//  rather than with a parser dependency. Every argument is checked
//  before anything starts: an unknown flag used to be ignored, so
//  `shuntd --version` booted the daemon, and a typo such as
//  `--instnace dev` would have started the default instance — the one
//  the service owns.
//
//  A service file passes the instance as an argument rather than an
//  environment variable, so `ps` shows which instance a process serves.

const INSTANCE_FLAGS = ["--instance", "-i"];
const INSTANCE_PREFIX = "--instance=";

//  Read by observability/trace.js.
const TRACING_FLAGS = ["--trace", "--verbose", "-v"];

const VERSION_FLAGS = ["--version", "-V"];
const HELP_FLAGS = ["--help", "-h"];

export const USAGE = `Usage: shuntd [options]

Options:
  -i, --instance <name>  Serve a named instance instead of the default.
  -v, --verbose          Print each request's lifecycle.
      --trace            Verbose, plus why each routing tier declined.
  -V, --version          Print the version and exit.
  -h, --help             Print this help and exit.

Environment:
  SHUNTD_INSTANCE        Instance name, when -i is not given.
  SHUNTD_VERBOSE=1       Same as --verbose.
  SHUNTD_TRACE=1         Same as --trace.`;

function missingValue(flag) {
    return new Error(`${flag} needs an instance name.`);
}

/**
 * Decides what the daemon should do with its arguments.
 *
 * Read left to right; the first --version or --help wins. Anything
 * the daemon does not know is an error, never ignored.
 * @param {string[]} args
 * @returns {"run" | "version" | "help"}
 * @throws {Error} on an unknown argument or a missing instance name.
 */
export function parseCommand(args) {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (VERSION_FLAGS.includes(arg)) {
            return "version";
        }

        if (HELP_FLAGS.includes(arg)) {
            return "help";
        }

        if (TRACING_FLAGS.includes(arg)) {
            continue;
        }

        if (arg.startsWith(INSTANCE_PREFIX)) {
            continue;
        }

        if (INSTANCE_FLAGS.includes(arg)) {
            const value = args[i + 1];

            if (value === undefined || value.startsWith("-")) {
                throw missingValue(arg);
            }

            i++;
            continue;
        }

        if (arg.startsWith("-")) {
            throw new Error(`Unknown option '${arg}'.`);
        }

        throw new Error(`Unexpected argument '${arg}'.`);
    }

    return "run";
}

/**
 * Reads `--instance <name>`, `--instance=<name>` or `-i <name>`.
 * @param {string[]} args
 * @returns {string | undefined}
 */
export function readInstanceFlag(args) {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith(INSTANCE_PREFIX)) {
            return arg.slice(INSTANCE_PREFIX.length);
        }

        if (!INSTANCE_FLAGS.includes(arg)) {
            continue;
        }

        const value = args[i + 1];

        if (value === undefined || value.startsWith("-")) {
            throw missingValue(arg);
        }

        return value;
    }

    return undefined;
}
