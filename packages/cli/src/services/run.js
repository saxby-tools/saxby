//  What a shell reports for a command that does not exist.
export const COMMAND_NOT_FOUND = 127;

/**
 * Runs a command to completion and returns its exit code and output.
 * Never throws on a non-zero exit; callers decide what failure means.
 *
 * A missing command also comes back as an exit code, 127, as a shell
 * reports it. Throwing instead crashed `shunt instance list` on any
 * Linux machine without systemctl, such as a container.
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export async function runCommand(command, args) {
    const child = new Deno.Command(command, {
        args,
        stdout: "piped",
        stderr: "piped",
    });

    let output;

    try {
        output = await child.output();
    } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
            throw err;
        }

        return {
            code: COMMAND_NOT_FOUND,
            stdout: "",
            stderr: `${command}: command not found`,
        };
    }

    const { code, stdout, stderr } = output;
    const decoder = new TextDecoder();

    return {
        code,
        stdout: decoder.decode(stdout),
        stderr: decoder.decode(stderr),
    };
}

/**
 * Like runCommand, but throws with the command's own stderr on
 * failure. For steps where a failure means the whole action failed.
 */
export async function runOrThrow(command, args) {
    const result = await runCommand(command, args);

    if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();

        throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
    }

    return result;
}
