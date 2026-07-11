// A simple, universal dev mode flag
export const IS_DEV = !Deno.build.standalone;

/**
 * Gets the user's home directory cross-platform.
 * @returns {string | null}
 */
export const getHomeDir = () => {
    return Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || null;
};

/**
 * Gets the standard configuration directory.
 * Respects XDG_CONFIG_HOME on Linux/macOS, falls back to ~/.config.
 * @throws {Error} If home directory cannot be determined.
 * @returns {string}
 */
export const getConfigDir = () => {
    const xdg = Deno.env.get("XDG_CONFIG_HOME");
    if (xdg) return xdg;

    const home = getHomeDir();
    if (home) return `${home}/.config`;

    // Chaos Hat: If we are running in a severely restricted environment where
    // neither HOME nor USERPROFILE exists, the daemon MUST crash loud.
    throw new Error(
        "FATAL: Could not determine user home directory. Please set XDG_CONFIG_HOME or HOME.",
    );
};
