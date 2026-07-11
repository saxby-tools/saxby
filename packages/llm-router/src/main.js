import { loadConfig } from "./config/loader.js";

async function main() {
    console.log("🚀 Starting shuntd llm-router...");

    try {
        const config = await loadConfig();
        console.log("✅ Configuration loaded and validated!");
        console.log(`🔗 Upstream target: ${config.upstream_url}`);
        console.log(
            `🧠 Loaded ${Object.keys(config.personas).length} personas.`,
        );

        // Next up: HTTP Server logic goes here...
    } catch (error) {
        console.error(error.message);
        Deno.exit(1);
    }
}

if (import.meta.main) {
    main();
}
