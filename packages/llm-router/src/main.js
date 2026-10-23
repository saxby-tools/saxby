import { Hono } from "@hono/hono";
import { logger } from "@hono/hono/logger";
import { registerRoutes } from "./routes/index.js";
import {
    fetchShuntdStatus,
    getInstanceDir,
    loadConfig,
    resolveInstanceName,
    validateTagContract,
} from "@shuntd/core";
import { initTracing, isVerbose } from "./observability/trace.js";
import { openDecisionLog } from "./log/db.js";
import { probeProfile } from "./semantic/embed.js";
import { warmExemplars } from "./semantic/exemplars.js";

const INSTANCE_FLAGS = ["--instance", "-i"];

//  Polled by `shunt` — every half second while a service starts — so
//  logging them buries the lines that matter.
const QUIET_PATHS = new Set(["/shuntd/v1/status"]);

/**
 * Reads `--instance <name>`, `--instance=<name>` or `-i <name>`.
 *
 * Hand-rolled like initTracing rather than a parser dependency: the
 * daemon takes four flags. A service file passes the name as an
 * argument so `ps` shows which instance a process serves.
 * @param {string[]} args
 * @returns {string | undefined}
 */
function readInstanceFlag(args) {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith("--instance=")) {
            return arg.slice("--instance=".length);
        }

        if (!INSTANCE_FLAGS.includes(arg)) {
            continue;
        }

        const value = args[i + 1];

        if (value === undefined || value.startsWith("-")) {
            throw new Error(`${arg} needs an instance name.`);
        }

        return value;
    }

    return undefined;
}

/**
 * Prepares Tier 3: resolves the active profile, confirms the embedder
 * answers, and warms the exemplar vector cache.
 *
 * Returns null on any failure. Tier 3 is an enhancement — a missing
 * embedder must cost semantic routing, never the router.
 */
async function warmSemantic(config, log) {
    if (!config.semantic) {
        return null;
    }

    if (!log) {
        console.warn(
            "⚠️  Tier 3 needs the decision log for its vector cache; " +
                "semantic routing disabled.",
        );

        return null;
    }

    const name = config.semantic.active;
    const profile = config.semantic.profiles?.[name];

    if (!profile) {
        console.warn(
            `⚠️  semantic.active is '${name}' but no such profile ` +
                `exists; semantic routing disabled.`,
        );

        return null;
    }

    try {
        const probe = await probeProfile(profile, config.upstream_url);

        const warmed = await warmExemplars(
            log.db,
            config,
            profile,
            config.upstream_url,
        );

        if (warmed.candidates.length === 0) {
            console.warn(
                "⚠️  No persona exemplars configured; Tier 3 has " +
                    "nothing to match against.",
            );

            return null;
        }

        console.log(
            `🧭 Tier 3: ${profile.model} (${probe.dim}d), ` +
                `${warmed.candidates.length} exemplars, ` +
                `threshold ${profile.threshold}`,
        );

        if (warmed.embedded + warmed.pruned > 0 || warmed.reused > 0) {
            console.log(
                `   embedded ${warmed.embedded}, reused ${warmed.reused}` +
                    (warmed.pruned > 0 ? `, pruned ${warmed.pruned}` : ""),
            );
        }

        return {
            profile,
            candidates: warmed.candidates,
            upstreamUrl: config.upstream_url,
        };
    } catch (error) {
        console.warn(
            `⚠️  Tier 3 unavailable, continuing without it: ` +
                error.message,
        );

        return null;
    }
}

/**
 * Turns a raw EADDRINUSE into which instance holds the port, and
 * which process to stop.
 *
 * Under launchd KeepAlive this message repeats every respawn, which
 * is the loudness a second supervisor deserves.
 */
async function describePortClash(port, instance) {
    const header = `❌ Port ${port} is already in use.`;
    const holder = await fetchShuntdStatus(port);

    if (!holder) {
        return `${header}\n` +
            `   The process holding it is not shuntd. Change ` +
            `listen_port in ${getInstanceDir(instance)}.`;
    }

    if (holder.instance !== instance) {
        return `${header}\n` +
            `   It is held by shuntd instance ` +
            `'${holder.instance ?? "default"}' (pid ${holder.pid}).`;
    }

    return `${header}\n` +
        `   Another shuntd is already serving this instance ` +
        `('${instance ?? "default"}', pid ${holder.pid}).\n` +
        `   Usual cause: a second supervisor — brew services, ` +
        `shunt service, or a dev run left open.`;
}

async function main() {
    console.log("🚀 Starting shuntd llm-router...");

    const level = initTracing(Deno.args);

    let config;
    let instance;

    try {
        instance = resolveInstanceName(readInstanceFlag(Deno.args));

        console.log(
            `📂 Instance: ${instance ?? "default"} ` +
                `(${getInstanceDir(instance)})`,
        );

        config = await loadConfig(instance);
        console.log("✅ Configuration loaded and validated!");
        console.log(`🔗 Upstream target: ${config.upstream_url}`);
        console.log(
            `🧠 Loaded ${Object.keys(config.personas).length} personas.`,
        );
    } catch (error) {
        console.error(error.message);
        Deno.exit(1);
    }

    const tagWarnings = validateTagContract(config);

    for (const warning of tagWarnings) {
        console.warn(`⚠️  ${warning}`);
    }

    if (level > 0) {
        console.log(`🔍 Tracing enabled (level ${level}).`);
    }

    //  The decision log is observability, never load-bearing. If it
    //  cannot be opened the router still routes — it just stops
    //  remembering, loudly.
    let log = null;

    try {
        log = openDecisionLog(config.log_path, config);

        console.log(`📓 Decision log: ${config.log_path}`);

        if (log.migration.applied > 0) {
            console.log(
                `   migrated v${log.migration.from} -> ` +
                    `v${log.migration.to} ` +
                    `(${log.migration.applied} step(s))`,
            );
        }

        if (!config.log_prompts) {
            console.log("   prompt text disabled (hashes only)");
        }
    } catch (error) {
        console.warn(
            `⚠️  Decision log unavailable, continuing without it: ` +
                error.message,
        );
    }

    const semantic = await warmSemantic(config, log);

    const app = new Hono();

    if (!isVerbose()) {
        const requestLogger = logger();

        app.use("*", (c, next) => {
            if (QUIET_PATHS.has(c.req.path)) {
                return next();
            }

            return requestLogger(c, next);
        });
    }

    app.use("*", async (c, next) => {
        c.set("config", config);
        c.set("instance", instance);
        c.set("log", log);
        c.set("semantic", semantic);
        await next();
    });

    registerRoutes(app);

    //  Global catch-all for unimplemented OpenAI endpoints.
    app.all("*", async (c) => {
        const url = new URL(c.req.url);
        console.log(`\n➡️ Proxying unhandled endpoint: ${url.pathname}`);

        const isGetOrHead = ["GET", "HEAD"].includes(c.req.method);

        const upstreamHeaders = new Headers(c.req.raw.headers);

        upstreamHeaders.delete("accept-encoding");
        upstreamHeaders.delete("content-length");
        upstreamHeaders.delete("host");

        const upstreamReq = new Request(
            `${config.upstream_url}${url.pathname}${url.search}`,
            {
                method: c.req.method,
                headers: upstreamHeaders,
                body: isGetOrHead ? undefined : c.req.raw.body,
                duplex: isGetOrHead ? undefined : "half",
            },
        );

        const upstreamRes = await fetch(upstreamReq);

        const headers = new Headers(upstreamRes.headers);

        headers.delete("content-encoding");
        headers.delete("content-length");

        return new Response(upstreamRes.body, {
            status: upstreamRes.status,
            headers,
        });
    });

    try {
        Deno.serve({ port: config.listen_port }, app.fetch);
    } catch (error) {
        if (!(error instanceof Deno.errors.AddrInUse)) {
            throw error;
        }

        console.error(await describePortClash(config.listen_port, instance));
        Deno.exit(1);
    }
}

if (import.meta.main) {
    main();
}
