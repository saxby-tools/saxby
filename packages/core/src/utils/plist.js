import plist from "plist";

/**
 * Generates a macOS LaunchDaemon/LaunchAgent XML string.
 * @param {Object} options - Override properties for the plist.
 * @param {string} options.Label - REQUIRED: The domain identifier.
 * @param {string[]} options.ProgramArguments - REQUIRED: The command and arguments.
 */
export const generatePlist = (options = {}) => {
    // 1. Guardrails for strictly required Apple properties
    if (!options.Label) {
        throw new Error("generatePlist: 'Label' is required.");
    }
    if (!options.ProgramArguments || !Array.isArray(options.ProgramArguments)) {
        throw new Error("generatePlist: 'ProgramArguments' array is required.");
    }

    // 2. Safe Defaults
    const defaults = {
        RunAtLoad: true,
        KeepAlive: true,
        // Dynamically default the log paths based on the required Label
        StandardErrorPath: `/tmp/${options.Label}.error.log`,
        StandardOutPath: `/tmp/${options.Label}.out.log`,
    };

    // 3. The Merge (Options overwrite Defaults)
    const mergedConfig = { ...defaults, ...options };

    // 4. Build and return the safely escaped XML string
    return plist.build(mergedConfig);
};
