import { Hono } from "@hono/hono";
import { logger } from "@hono/hono/logger";
import { join } from "@std/path";
import { registerRoutes } from "./routes/index.js";
import {
    fetchSaxbyStatus,
    findMemoryProbe,
    formatGib,
    getInstanceDir,
    instanceLabel,
    instancePhrase,
    loadConfig,
    OllamaAdapter,
    resolveInstanceName,
    validateTagContract,
} from "@saxby/core";
import { initTracing, isVerbose } from "./observability/trace.js";
import { openDecisionLog } from "./log/db.js";
import { createBroker } from "./memory/broker.js";
import { describePinnedGap } from "./memory/budget.js";
import { isProcessAlive } from "./memory/liveness.js";
import { createSizeCache } from "./memory/sizes.js";
import { probeProfile } from "./semantic/embed.js";
import { warmExemplars } from "./semantic/exemplars.js";
import { inspectRequest } from "./security/guard.js";
import { parseCommand, readInstanceFlag, USAGE } from "./args.js";
import packageConfig from "../deno.json" with { type: "json" };

//  Loopback only. Saxby checks no credentials, so nothing beyond this
//  machine may reach it until keys exist (AGENTS.md). Docker Desktop's
//  host.docker.internal and `tailscale serve` both reach loopback.
const LISTEN_HOSTNAME = "127.0.0.1";

//  Polled by `saxby` — every half second while a service starts — so
//  logging them buries the lines that matter. Every running
//  `saxby reserve` heartbeats too.
const QUIET_PATHS = new Set(["/saxby/v1/status"]);
const HEARTBEAT_PATH = /^\/saxby\/v1\/reservations\/[^/]+\/heartbeat$/;

//  The usual exit code for a command-line usage error.
const EXIT_USAGE = 2;

//  The prompt hash key lives beside the config, not beside the log:
//  it belongs to the instance, wherever log_path points.
const KEY_FILE = "prompt-hash.key";

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

    //  validateConfig guarantees semantic.active names a profile, so
    //  a missing one stops the boot before this runs.
    const profile = config.semantic.profiles[config.semantic.active];

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
 * Measured sizes from the decision log, or none. Losing them only
 * makes the broker more careful, so a failed read never stops a boot.
 */
function readModelSizes(log) {
    if (!log) {
        return [];
    }

    try {
        return log.loadModelSizes();
    } catch (error) {
        console.warn(`⚠️  Model sizes unavailable: ${error.message}`);
        return [];
    }
}

/**
 * Builds the memory broker (docs/memory-broker.md).
 *
 * The backend is Ollama: it is Saxby's only backend adapter, and the
 * catch-all already speaks Ollama's native API. When a second adapter
 * exists the config must name one, since detecting at boot races the
 * backend's own start.
 */
function startBroker(config, log) {
    const sizes = createSizeCache({
        rows: readModelSizes(log),
        save: (model, bytes, measuredAt) =>
            log?.saveModelSize(model, bytes, measuredAt),
    });

    const broker = createBroker({
        config,
        probe: findMemoryProbe(),
        backend: OllamaAdapter,
        upstreamUrl: config.upstream_url,
        isAlive: isProcessAlive,
        sizes,
        record: (event) => log?.memory(event),
    });

    broker.start();

    return broker;
}

function describePinned(term) {
    if (term.bytes === null) {
        return `${term.model} (size unknown)`;
    }

    return `${term.model} ${formatGib(term.bytes)} (${term.source})`;
}

/**
 * Prints the budget at boot. A pinned model with no size is warned
 * about: pinning it was a choice, and every job is refused until it
 * is fixed, so it is better found now than at the first job. An
 * unmeasured ceiling is only noted, because on a Mac at the macOS
 * default and on every Linux box it is the normal state, and it only
 * matters to someone about to run `saxby reserve`. A backend that did
 * not answer is noted too; it is read again at every request.
 */
async function announceBroker(broker) {
    const { budget } = await broker.snapshot();

    const ceiling = budget.ceilingBytes === null
        ? `unknown (${budget.ceilingSource}); set memory.ceiling_gib ` +
            `before using saxby reserve`
        : `${formatGib(budget.ceilingBytes)} (${budget.ceilingSource})`;

    console.log(
        `🧮 Memory broker: ceiling ${ceiling}, ` +
            `margin ${formatGib(budget.marginBytes)}`,
    );

    if (budget.pinned.length > 0) {
        console.log(
            `   pinned: ${budget.pinned.map(describePinned).join(", ")}`,
        );
    }

    if (budget.residencyError !== null) {
        console.log(`   backend not answering yet: ${budget.residencyError}`);
    }

    for (const term of budget.pinned) {
        if (term.bytes !== null) {
            continue;
        }

        console.warn(
            `⚠️  Jobs will be refused until this is fixed: ` +
                describePinnedGap(term),
        );
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
    const holder = await fetchSaxbyStatus(port);

    if (!holder) {
        return `${header}\n` +
            `   The process holding it is not saxbyd. Change ` +
            `listen_port in ${getInstanceDir(instance)}.`;
    }

    if (holder.instance !== instance) {
        return `${header}\n` +
            `   It is held by ${instancePhrase(holder.instance)} ` +
            `(pid ${holder.pid}).`;
    }

    return `${header}\n` +
        `   Another saxbyd is already serving ` +
        `${instancePhrase(instance)} (pid ${holder.pid}).\n` +
        `   Usual cause: a second supervisor — brew services, ` +
        `saxby service, or a terminal run left open.`;
}

/**
 * First middleware on every route. Refuses proxied, browser and
 * rebinding requests and Ollama's management paths, before the request
 * logger or any route sees them (security/guard.js says why).
 */
async function guardRequests(c, next) {
    const verdict = inspectRequest({
        headers: c.req.raw.headers,
        path: c.req.path,
    });

    if (!verdict) {
        return await next();
    }

    const source = c.env?.remoteAddr?.hostname ?? "unknown";

    console.warn(
        `🚫 ${verdict.code}: ${c.req.method} ${c.req.path} ` +
            `from ${source}`,
    );

    return c.json({
        error: {
            message: verdict.message,
            type: "invalid_request_error",
            code: verdict.code,
        },
    }, verdict.status);
}

/**
 * Handles --version, --help and bad arguments before anything starts.
 * @returns {boolean} true when the daemon should go on to start.
 */
function shouldStart(args) {
    let command;

    try {
        command = parseCommand(args);
    } catch (err) {
        console.error(`❌ ${err.message}\n\n${USAGE}`);
        Deno.exit(EXIT_USAGE);
    }

    if (command === "version") {
        console.log(`saxbyd ${packageConfig.version}`);
        return false;
    }

    if (command === "help") {
        console.log(USAGE);
        return false;
    }

    return true;
}

async function main() {
    if (!shouldStart(Deno.args)) {
        return;
    }

    console.log("🚀 Starting saxbyd...");

    const level = initTracing(Deno.args);

    let config;
    let instance;

    try {
        instance = resolveInstanceName(readInstanceFlag(Deno.args));

        console.log(
            `📂 Instance: ${instanceLabel(instance)} ` +
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
        log = await openDecisionLog(
            config.log_path,
            config,
            join(getInstanceDir(instance), KEY_FILE),
        );

        console.log(`📓 Decision log: ${config.log_path}`);

        if (log.migration.applied > 0) {
            console.log(
                `   migrated v${log.migration.from} -> ` +
                    `v${log.migration.to} ` +
                    `(${log.migration.applied} step(s))`,
            );
        }

        if (log.tightened.length > 0) {
            console.log(
                `   made owner-only: ${log.tightened.join(", ")}`,
            );
        }

        //  Printed either way. With text off by default, the quiet
        //  case is the one storing prompts, so neither may be silent.
        if (config.log_prompts) {
            console.log("   prompt text: logged (log_prompts: true)");
        }

        if (!config.log_prompts) {
            console.log("   prompt text: hashes only (log_prompts: false)");
        }
    } catch (error) {
        console.warn(
            `⚠️  Decision log unavailable, continuing without it: ` +
                error.message,
        );
    }

    const semantic = await warmSemantic(config, log);

    //  After Tier 3 warms, so the embedder it just loaded is measured.
    const broker = startBroker(config, log);

    await announceBroker(broker);

    const app = new Hono();

    app.use("*", guardRequests);

    if (!isVerbose()) {
        const requestLogger = logger();

        app.use("*", (c, next) => {
            if (QUIET_PATHS.has(c.req.path)) {
                return next();
            }

            if (HEARTBEAT_PATH.test(c.req.path)) {
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
        c.set("broker", broker);
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
        Deno.serve(
            { hostname: LISTEN_HOSTNAME, port: config.listen_port },
            app.fetch,
        );
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
