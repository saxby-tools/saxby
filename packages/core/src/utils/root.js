/**
 * Executes a shell script via Apple's native privilege escalation.
 * Prompts the user with the native macOS Touch ID / Password dialog.
 * * @param {string} shellScript - The bash commands to execute as root.
 */
export const executeAsRootMac = async (shellScript) => {
    // Escape backslashes and double quotes so AppleScript doesn't break
    const escapedScript = shellScript.replace(/\\/g, "\\\\").replace(
        /"/g,
        '\\"',
    );
    const appleScript =
        `do shell script "${escapedScript}" with administrator privileges`;

    const command = new Deno.Command("osascript", {
        args: ["-e", appleScript],
        stdout: "piped",
        stderr: "piped",
    });

    const { code, stdout, stderr } = await command.output();

    if (code !== 0) {
        const errStr = new TextDecoder().decode(stderr);
        throw new Error(`AppleScript Root Execution Failed:\n${errStr}`);
    }

    return new TextDecoder().decode(stdout);
};
