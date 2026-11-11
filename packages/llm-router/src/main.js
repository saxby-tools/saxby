/* @ts-self-types="./main.d.ts" */
/**
 * `saxbyd`, the Saxby daemon. It sits in front of an OpenAI-compatible
 * backend and routes each chat request to the right local model,
 * logging every decision with its reasons. This entry point runs the
 * program and exports nothing; install it with
 * `deno install -g -n saxbyd jsr:@saxby/llm-router`.
 *
 * @example Run with routing trace output
 * ```bash
 * saxbyd --trace
 * ```
 * @module
 */

import { Hono } from "@hono/hono";
import { logger } from "@hono/hono/logger";
import { basename, join } from "@std/path";
import { registerRoutes } from "./routes/index.js";
import { registerCatchAll } from "./routes/catch-all.js";
import {
    fetchSaxbyStatus,
    findMemoryProbe,
    formatGib,
    getInstanceDir,
    instanceLabel,
    instancePhrase,
    isWeakApiToken,
    loadConfig,
    OllamaAdapter,
    probeHostFor,
    readOrCreateApiToken,
    resolveInstanceName,
    validateTagContract,
} from "@saxby/core";
import { initTracing, isVerbose } from "./observability/trace.js";
import { createReloader } from "./config/reload.js";
import { watchConfig } from "./config/watch.js";
import { openDecisionLog } from "./log/db.js";
import { createBroker } from "./memory/broker.js";
import { describePinnedGap } from "./memory/budget.js";
import { isProcessAlive } from "./memory/liveness.js";
import { announceNeighbours } from "./memory/neighbours.js";
import { createSizeCache } from "./memory/sizes.js";
import { probeProfile } from "./semantic/embed.js";
import { warmExemplars } from "./semantic/exemplars.js";
import {
    buildAllowedHosts,
    judgeRequest,
    TOKEN_VALID,
} from "./security/guard.js";
import { isInContainer, isLoopbackHost } from "./security/listen.js";
import { tokenStateFor } from "./security/token.js";
import { parseCommand, readInstanceFlag, USAGE } from "./args.js";
import packageConfig from "../deno.json" with { type: "json" };

//  Sent with a 401, as HTTP requires, so a client knows what to send.
const AUTHENTICATE_HEADER = 'Bearer realm="saxby"';
const STATUS_UNAUTHORIZED = 401;

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
 * Returns null when the config asks for no Tier 3 or gives it nothing
 * to match. Throws when the embedder cannot be used, so the caller
 * decides what that costs: a boot goes on without Tier 3, and a reload
 * keeps the Tier 3 it has (config/reload.js).
 */
async function buildSemantic(config, log) {
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
}

/**
 * Tier 3 at boot. Returns null on any failure: Tier 3 is an
 * enhancement, and a missing embedder must cost semantic routing,
 * never the router.
 */
async function warmSemantic(config, log) {
    try {
        return await buildSemantic(config, log);
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
async function describePortClash(config, instance) {
    const port = config.listen_port;
    const header = `❌ Port ${port} is already in use.`;
    const holder = await fetchSaxbyStatus(
        port,
        probeHostFor(config.listen_host),
    );

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
 * Reads this instance's API token, writing one at first boot.
 *
 * Returns null on any failure. Local clients never need the token, so
 * a broken token file costs the other machines their way in, loudly,
 * and never the router.
 * @returns {Promise<string | null>}
 */
async function loadApiToken(instance) {
    let found;

    try {
        found = await readOrCreateApiToken(getInstanceDir(instance));
    } catch (error) {
        console.warn(
            `⚠️  API token unavailable, so only this machine is ` +
                `served: ${error.message}`,
        );

        return null;
    }

    if (found.created) {
        console.log(`🔑 API token written to ${found.path}`);
    }

    if (isWeakApiToken(found.token)) {
        console.warn(
            `⚠️  The API token is ${found.token.length} characters ` +
                `long. One that short can be guessed by anyone who can ` +
                `reach Saxby from another machine. 'saxby token rotate' ` +
                `writes a strong one.`,
        );
    }

    return found.token;
}

/**
 * Says at boot which proxies are trusted. Naming one lets other
 * machines in, so it is never silent.
 */
function announceProxies(config) {
    for (const proxy of config.trusted_proxies) {
        console.log(`🔓 Trusted proxy: ${proxy.kind} at ${proxy.host}`);
    }

    if (config.trusted_proxies.length === 0) {
        return;
    }

    console.log(
        "   Requests through it need the API token ('saxby token') " +
            "and reach /v1/chat/completions and /v1/models only.",
    );
}

/**
 * Says at boot which browser extensions are let in, for the same
 * reason: a way in is never silent.
 */
function announceOrigins(config) {
    for (const origin of config.allowed_origins) {
        console.log(`🧩 Browser extension allowed: ${origin}`);
    }

    if (config.allowed_origins.length === 0) {
        return;
    }

    console.log(
        "   An extension can use /v1/chat/completions and /v1/models, " +
            "and nothing else.",
    );
}

/**
 * Says which extra Host names the guard accepts.
 */
function announceHosts(config) {
    if (config.allowed_hosts.length === 0) {
        return;
    }

    const names = config.allowed_hosts.join(", ");

    console.log(`🛡️  Host names also accepted: ${names}`);
}

/**
 * Says whether prompt text is stored. Printed either way: with text
 * off by default, the quiet case is the one storing prompts, so
 * neither may be silent.
 */
function announcePromptText(config) {
    if (config.log_prompts) {
        console.log("   prompt text: logged (log_prompts: true)");
        return;
    }

    console.log("   prompt text: hashes only (log_prompts: false)");
}

/**
 * Says whether user messages get the time note, and in which zone. A
 * note the model reads on every message is never added silently. At
 * boot the default, off, is not worth a line; after a save that
 * changed the block, either state is.
 */
function announceMessagePrefix(config, sayOff) {
    const settings = config.message_prefix;

    if (!settings.enabled) {
        if (sayOff) {
            console.log("🕒 Time note on user messages: off.");
        }

        return;
    }

    const gap = settings.gap_sentence ? "with" : "without";

    console.log(
        `🕒 Time note on every user message, zone ` +
            `${settings.timezone}, ${gap} the gap sentence.`,
    );
}

/**
 * Says so when a reload emptied a list of ways in. The announce
 * functions print nothing for an empty list, and an operator who just
 * closed a door wants to see that it took.
 */
function announceClosed(config, changed) {
    if (changed.includes("trusted_proxies")) {
        if (config.trusted_proxies.length === 0) {
            console.log("🔒 No proxy is trusted now.");
        }
    }

    if (changed.includes("allowed_origins")) {
        if (config.allowed_origins.length === 0) {
            console.log("🔒 No browser extension is allowed now.");
        }
    }

    if (changed.includes("allowed_hosts")) {
        if (config.allowed_hosts.length === 0) {
            console.log("🔒 Only local Host names are accepted now.");
        }
    }
}

/**
 * Hands a reloaded config to everything that keeps its own copy of
 * part of it, right after the swap and in the same tick, so no request
 * meets a guard, a broker and a route that disagree. Then says what a
 * boot would have said about the fields that changed: a way in is
 * never silent, whether it opened at boot or on a save.
 * @param {{ config: Object }} state - from the reloader
 * @param {string[]} changed - top-level config fields that differ
 * @param {{ access: Object, broker: Object, log: Object | null }} parts
 */
function applyReload(state, changed, parts) {
    const config = state.config;

    parts.access.config = config;
    parts.access.allowedHosts = buildAllowedHosts(config.allowed_hosts);
    parts.broker.reconfigure(config);
    parts.log?.setLogPrompts(config.log_prompts);
    parts.log?.setLogProxyUsers(config.log_proxy_users);

    //  Tags live in these two. Repeating the boot's warnings after an
    //  edit that touched neither would bury the line that matters.
    const tagsMoved = changed.includes("catalog") ||
        changed.includes("personas");

    if (tagsMoved) {
        for (const warning of validateTagContract(config)) {
            console.warn(`⚠️  ${warning}`);
        }
    }

    if (changed.includes("upstream_url")) {
        console.log(`🔗 Upstream target: ${config.upstream_url}`);
    }

    if (changed.includes("trusted_proxies")) {
        announceProxies(config);
    }

    if (changed.includes("allowed_origins")) {
        announceOrigins(config);
    }

    if (changed.includes("allowed_hosts")) {
        announceHosts(config);
    }

    if (changed.includes("log_prompts")) {
        announcePromptText(config);
    }

    if (changed.includes("message_prefix")) {
        announceMessagePrefix(config, true);
    }

    announceClosed(config, changed);

    //  Pins and sizes come from these two. A newly pinned model with
    //  no size refuses every job, which is better read now.
    const pinsMoved = changed.includes("catalog") ||
        changed.includes("semantic");

    if (pinsMoved) {
        announceBroker(parts.broker).catch((error) => {
            console.warn(`⚠️  Memory budget not printed: ${error.message}`);
        });
    }
}

/**
 * Says what the bind means, once, before listening. A bind beyond
 * loopback is the operator's call (AGENTS.md), so it is named, not
 * refused: what protects it is the API token, which every request
 * from another machine must carry. A loopback bind inside a container
 * is the usual first-run mistake: the published port never answers.
 */
async function announceListen(config, apiToken) {
    const where = `${config.listen_host}:${config.listen_port}`;

    if (!isLoopbackHost(config.listen_host)) {
        console.log(
            `🌐 Listening on ${where}, beyond loopback. A request from ` +
                `another machine needs the API token ('saxby token') ` +
                `and reaches /v1/chat/completions and /v1/models only.`,
        );

        if (apiToken === null) {
            console.warn(
                `⚠️  With no API token, nothing beyond this machine ` +
                    `can be served on ${where}.`,
            );
        }

        return;
    }

    if (await isInContainer()) {
        console.log(
            `ℹ️  Running in a container with listen_host ` +
                `${config.listen_host}: a published port will not ` +
                `answer. Set listen_host to 0.0.0.0 ` +
                `(docs/docker.md).`,
        );
    }
}

/**
 * First middleware on every route. Refuses browser and rebinding
 * requests, Ollama's management paths, any request from another
 * machine without the API token, and any proxied request that does
 * not fit a proxy named in the config, before the request logger or
 * any route sees them (security/guard.js says why). A request let in
 * through a trusted proxy carries the guard's note of who called, for
 * the decision log; the chat route reads it from the context, never
 * from the headers.
 * @param {{ config: Object, apiToken: string | null,
 *     allowedHosts: Set<string> }} access - the token is fixed at
 *     boot; config and allowedHosts are replaced together when the
 *     config is reloaded (applyReload)
 */
async function guardRequests(c, next, access) {
    const { config, apiToken, allowedHosts } = access;
    const tokenState = tokenStateFor(c.req.header("authorization"), apiToken);

    //  The routes must never pass Saxby's own token on to the backend.
    //  Set for a local client too, if it sent the token.
    if (tokenState === TOKEN_VALID) {
        c.set("sentApiToken", true);
    }

    const { verdict, proxyCaller } = judgeRequest({
        headers: c.req.raw.headers,
        path: c.req.path,
        method: c.req.method,
        remoteHostname: c.env?.remoteAddr?.hostname,
        trustedProxies: config.trusted_proxies,
        allowedOrigins: config.allowed_origins,
        allowedHosts,
        tokenState,
    });

    if (!verdict) {
        if (proxyCaller) {
            c.set("proxyCaller", proxyCaller);
        }

        return await next();
    }

    const source = c.env?.remoteAddr?.hostname ?? "unknown";

    console.warn(
        `🚫 ${verdict.code}: ${c.req.method} ${c.req.path} ` +
            `from ${source}`,
    );

    if (verdict.status === STATUS_UNAUTHORIZED) {
        c.header("WWW-Authenticate", AUTHENTICATE_HEADER);
    }

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

    const apiToken = await loadApiToken(instance);

    announceProxies(config);
    announceOrigins(config);
    announceMessagePrefix(config, false);

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

        //  Names only: the line above already says where the log is.
        if (log.tightened.length > 0) {
            const names = log.tightened.map((path) => basename(path));

            console.log(`   made owner-only: ${names.join(", ")}`);
        }

        announcePromptText(config);
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

    //  Each instance's broker is its own. One line per other instance
    //  whose saxbyd answers, so a job reserved there is a known gap,
    //  not a silent one. Observability only: never on the request
    //  path, and never allowed to stop a boot.
    await announceNeighbours({ instance }).catch(() => {});

    const app = new Hono();

    const access = {
        config,
        apiToken,
        allowedHosts: buildAllowedHosts(config.allowed_hosts),
    };

    //  From here on `config` is only the config saxbyd booted with.
    //  Whatever serves a request reads the reloader's, which a save
    //  to the config file replaces.
    const reloader = createReloader({
        config,
        semantic,
        load: () => loadConfig(instance),
        warm: (next) => buildSemantic(next, log),
        onApply: (state, changed) =>
            applyReload(state, changed, { access, broker, log }),
    });

    const watching = watchConfig({
        dir: getInstanceDir(instance),
        reload: reloader.reload,
    });

    if (watching.error() === null) {
        console.log("👀 Watching the config file; a save is applied live.");
    }

    //  Read by the status route, so `saxby status` can say when the
    //  file on disk is not the config that is running.
    const readConfigState = () => ({
        ...reloader.status(),
        watch_error: watching.error(),
    });

    app.use("*", (c, next) => guardRequests(c, next, access));

    announceHosts(config);

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
        //  Read once, so a request sees one config and the Tier 3
        //  vectors built for it, even if a reload lands mid-request.
        const current = reloader.current();

        c.set("config", current.config);
        c.set("configState", readConfigState);
        c.set("instance", instance);
        c.set("log", log);
        c.set("semantic", current.semantic);
        c.set("broker", broker);
        await next();
    });

    registerRoutes(app);

    //  Last, so it sees only what no route served: Ollama's own API,
    //  passed through, with its inference paths gated while a job
    //  holds memory.
    registerCatchAll(app);

    await announceListen(config, apiToken);

    try {
        Deno.serve(
            { hostname: config.listen_host, port: config.listen_port },
            app.fetch,
        );
    } catch (error) {
        if (!(error instanceof Deno.errors.AddrInUse)) {
            throw error;
        }

        console.error(await describePortClash(config, instance));
        Deno.exit(1);
    }
}

if (import.meta.main) {
    main();
}
