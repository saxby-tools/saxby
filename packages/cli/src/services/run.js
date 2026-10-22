/**
 * Runs a command to completion and returns its exit code and output.
 * Never throws on a non-zero exit; callers decide what failure means.
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

    const { code, stdout, stderr } = await child.output();
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
