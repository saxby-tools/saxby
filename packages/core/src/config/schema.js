import * as v from "valibot";

/**
 * Memory broker default: GiB kept free beyond every model and
 * reservation (docs/memory-broker.md says why).
 */
export const DEFAULT_MARGIN_GIB = 8;

/**
 * Memory broker default: seconds a job or a model load waits for
 * room before it is refused (docs/memory-broker.md says why).
 */
export const DEFAULT_WAIT_TIMEOUT_S = 120;

/**
 * Memory broker default: seconds between `saxby reserve` check-ins,
 * and between saxbyd's sweeps for reservations whose job has died
 * (docs/memory-broker.md says why).
 */
export const DEFAULT_HEARTBEAT_INTERVAL_S = 10;

/**
 * Loopback: this machine only, the one caller that needs no API
 * token (AGENTS.md).
 */
export const DEFAULT_LISTEN_HOST = "127.0.0.1";

/**
 * The one kind of proxy Saxby knows how to judge. A kind is added
 * only with the checks that make it safe (llm-router's guard.js).
 */
export const PROXY_KIND_TAILSCALE_SERVE = "tailscale-serve";

//  A bare DNS name: no scheme, no port, no path.
const PROXY_HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

/**
 * A browser extension's origin: "chrome-extension://<id>" or
 * "moz-extension://<uuid>". Lowercase, as browsers send it, with no
 * path and no wildcard. The second group is the extension's id.
 * The only kind of origin Saxby lets in: a web page would also need
 * CORS answers, which Saxby does not give.
 */
export const EXTENSION_ORIGIN =
    /^(chrome-extension|moz-extension|safari-web-extension):\/\/([a-z0-9-]+)$/;

/**
 * The one reasoning_effort Saxby will add for a client. It is the
 * only value safe on every model: Ollama answers 400 to any other
 * when the model has no reasoning to turn down (seen on 0.40.15).
 */
export const REASONING_EFFORT_NONE = "none";

/**
 * Prefix of the request headers `forward_user_headers` governs, in
 * lowercase as Headers reports names: Open WebUI's
 * X-OpenWebUI-User-Name, -Id, -Email, -Role and -Jwt. They name the
 * person at the keyboard. Every route that forwards to the backend
 * strips them unless the switch is on (llm-router's routes).
 */
export const USER_HEADER_PREFIX = "x-openwebui-user-";

//  A client signature as the router's log/client.js spells it: the
//  User-Agent's product token, lowercased. "LeanType/1.0" is
//  "leantype". A key in any other shape would never match a client.
const CLIENT_SIGNATURE = /^[a-z][a-z0-9_.-]*$/;

//  Named so the error can say what a good value looks like.
const TIMEZONE_EXAMPLE = "America/Chicago";

//  The one IANA name with no slash in it that is worth accepting.
const TIMEZONE_UTC = "UTC";

/**
 * The zone this machine keeps time in, as an IANA name. Right for a
 * tool that serves one machine: the person at the keyboard is in the
 * zone the machine is set to.
 * @returns {string}
 */
export function hostTimeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Whether this is an IANA zone name the runtime knows. The zone list
 * ships with the runtime, not with Saxby, so Intl is the only check
 * there is. Intl also takes abbreviations ("CST") and offsets
 * ("+05:30"), and both are refused: an abbreviation is ambiguous and
 * an offset is read worse than a name, which is why the note carries
 * the name. IANA names are Area/Location, linked names such as
 * "US/Central" included, plus "UTC". Intl.supportedValuesOf is not
 * used: it lists ICU's canonical ids, which leave out "UTC" and spell
 * some zones by their old names.
 * @param {string} name
 * @returns {boolean}
 */
export function isTimeZone(name) {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: name });
    } catch {
        return false;
    }

    if (name === TIMEZONE_UTC) {
        return true;
    }

    return name.includes("/");
}

/**
 * A tag as the vocabulary spells it: uppercase letters, digits and
 * underscores, such as TAG_CODER. Whether the tag exists is checked
 * by validateTagContract, since a claim nothing emits is a warning,
 * not an invalid file.
 */
export const TagSchema = v.pipe(
    v.string(),
    v.regex(
        /^[A-Z0-9_]+$/,
        "Tags must be uppercase alphanumeric with underscores.",
    ),
);

//  A size in GiB, as people write it. Zero is refused: a model that
//  takes no memory would hide its real size from the budget.
const SizeGibSchema = v.pipe(
    v.number("size_gib must be a number"),
    v.check((gib) => gib > 0, "size_gib must be greater than 0"),
);

/**
 * One catalog entry: a model the router may pick, the tags it claims
 * for Tier 2a, and what the memory broker needs to know about its
 * size.
 */
export const ModelSchema = v.strictObject({
    name: v.string("Model name is required"),
    description: v.optional(v.string()),
    max_context: v.pipe(
        v.number(),
        v.minValue(1, "max_context must be greater than 0"),
    ),
    capabilities: v.optional(v.array(TagSchema), []),
    //  Injected as a system message for this model only. Fixes
    //  model-specific behaviour at the cause (decoding) rather than
    //  rewriting the response after the fact.
    system_prefix: v.optional(v.string()),
    //  The memory broker never lets a job take a pinned model's
    //  space, whether the model is loaded or not.
    pinned: v.optional(v.boolean(), false),
    //  The least the memory broker counts the model at, loaded or
    //  not. A larger size the backend reports wins; a smaller one
    //  does not, since Ollama books a model on its MLX runner at its
    //  size at load time, before the KV cache grows.
    size_gib: v.optional(SizeGibSchema),
});

/**
 * One persona: the tags and exemplars that reach it, and the model it
 * routes to. Tier 2b matches on `tags`, Tier 3 on `exemplars`.
 */
export const PersonaSchema = v.strictObject({
    description: v.optional(v.string()),
    exemplars: v.optional(v.array(v.string()), []),
    //  Tier 2b: personas claim tags too, so a partially tagged
    //  catalog still routes instead of collapsing to the global
    //  default. Catalog capabilities win when both match.
    tags: v.optional(v.array(TagSchema), []),
    default_model: v.string(
        "Every persona must have a default fallback model ID",
    ),
});

/**
 * One embedder for Tier 3. The threshold lives here rather than on
 * `semantic` because cosine calibration is model-specific, so an A/B
 * between embedders is one config line, not a retuning.
 */
export const SemanticProfileSchema = v.strictObject({
    model: v.string("Semantic model name is required"),
    dim: v.pipe(
        v.number("Dimension must be a number"),
        v.minValue(1, "Dimension must be at least 1"),
    ),
    threshold: v.pipe(
        v.number("Threshold must be a number"),
        v.minValue(0, "Threshold must be >= 0.0"),
        v.maxValue(1, "Threshold must be <= 1.0"),
    ),
    //  The active embedder is pinned without asking, since Tier 3
    //  loads it for routed requests, and embedders never sit in the
    //  catalog where `pinned` lives. A floor, as in the catalog.
    size_gib: v.optional(SizeGibSchema),
});

/**
 * Tier 3 settings: the named embedder profiles and which one is
 * active. validateConfig checks that `active` names a profile.
 */
export const SemanticSchema = v.strictObject({
    active: v.string("Active semantic profile is required"),
    profiles: v.record(v.string(), SemanticProfileSchema),
});

/**
 * Memory broker settings. Every field has a default, so a config
 * with no `memory` section still runs the broker.
 */
export const MemorySchema = v.strictObject({
    //  Kept free beyond every model and reservation.
    margin_gib: v.optional(
        v.pipe(
            v.number("margin_gib must be a number"),
            v.minValue(0, "margin_gib must be >= 0"),
        ),
        DEFAULT_MARGIN_GIB,
    ),
    //  How long a job or a model load waits for room before it is
    //  refused. `saxby reserve --timeout` overrides it for one job.
    wait_timeout_s: v.optional(
        v.pipe(
            v.number("wait_timeout_s must be a number"),
            v.minValue(0, "wait_timeout_s must be >= 0"),
        ),
        DEFAULT_WAIT_TIMEOUT_S,
    ),
    //  How often `saxby reserve` checks in, and how often saxbyd looks
    //  for reservations whose processes have died.
    heartbeat_interval_s: v.optional(
        v.pipe(
            v.number("heartbeat_interval_s must be a number"),
            v.minValue(1, "heartbeat_interval_s must be >= 1"),
        ),
        DEFAULT_HEARTBEAT_INTERVAL_S,
    ),
    //  Used only when the memory probe cannot measure the ceiling.
    ceiling_gib: v.optional(SizeGibSchema),
});

/**
 * One proxy saxbyd accepts forwarding headers from, by kind and by
 * the Host name clients reach it at. Every other proxy is refused.
 */
export const TrustedProxySchema = v.strictObject({
    kind: v.picklist(
        [PROXY_KIND_TAILSCALE_SERVE],
        `kind must be '${PROXY_KIND_TAILSCALE_SERVE}'`,
    ),
    //  The name clients use to reach the proxy, as it arrives in the
    //  Host header: "my-mac.my-tailnet.ts.net".
    host: v.pipe(
        v.string("host is required"),
        v.regex(
            PROXY_HOST,
            "host must be a bare name, with no https:// and no port",
        ),
    ),
});

/**
 * Request fields Saxby fills in for one client when the request
 * leaves them out. A closed list: each field here is one the chat
 * route knows how to add and the decision log knows how to show.
 */
export const ClientDefaultsSchema = v.strictObject({
    reasoning_effort: v.optional(
        v.picklist(
            [REASONING_EFFORT_NONE],
            `reasoning_effort must be '${REASONING_EFFORT_NONE}'`,
        ),
    ),
});

/**
 * The time note on every user message (docs/configuration.md,
 * "Message prefix"). Off until v1 ships it. One block for every
 * model: the lab tested one model, and the note costs each the same.
 */
export const MessagePrefixSchema = v.strictObject({
    enabled: v.optional(v.boolean(), false),
    //  The zone the note is written in. From the config or, one day,
    //  the client; never guessed from anything else. The default is
    //  the host's, which is the user's on a machine that serves one
    //  person. An unknown name is refused here rather than found at
    //  the first request.
    timezone: v.optional(
        v.pipe(
            v.string("timezone must be a string"),
            v.check(
                isTimeZone,
                `timezone is not a known IANA zone name; use one such ` +
                    `as '${TIMEZONE_EXAMPLE}'`,
            ),
        ),
        hostTimeZone,
    ),
    //  "This conversation resumed after 12 days away." on the latest
    //  note. The larger lever in the lab, so on unless turned off.
    gap_sentence: v.optional(v.boolean(), true),
});

/**
 * The whole config file. Unknown fields are refused rather than
 * ignored, so a misspelt key cannot pass for a setting that took.
 * Checks across fields, such as every named model being in the
 * catalog, live in validateConfig.
 */
export const SaxbyConfigSchema = v.strictObject({
    listen_port: v.optional(
        v.pipe(
            v.number(),
            v.minValue(1024, "Port must be > 1023"),
            v.maxValue(65535, "Port must be < 65536"),
        ),
        11435,
    ),
    //  Any address Deno.serve accepts. Loopback is unreachable from
    //  outside a container, and a lab box binds one interface on
    //  purpose, so nothing is refused here: saxbyd warns at boot when
    //  the bind is not loopback, and the exposure is the operator's
    //  call.
    listen_host: v.optional(
        v.pipe(
            v.string("listen_host must be a string"),
            v.minLength(1, "listen_host must not be empty"),
        ),
        DEFAULT_LISTEN_HOST,
    ),
    //  Names the guard accepts in Host besides the local ones, such
    //  as a Compose service name. A browser cannot forge Host, so a
    //  name here loosens nothing against DNS rebinding.
    allowed_hosts: v.optional(
        v.array(
            v.pipe(
                v.string("allowed_hosts entries must be strings"),
                v.minLength(1, "allowed_hosts entries must not be empty"),
            ),
        ),
        [],
    ),
    upstream_url: v.optional(v.string(), "http://127.0.0.1:11434"),
    //  When true, a request that sets `stream: false` is tagged
    //  TAG_BACKGROUND, plus any TAG_VISION / TAG_AUDIO requirement,
    //  and skips the structural scan (looksLikeBackgroundTask in
    //  extract.js). Utility generators — titles, tags, follow-ups —
    //  are the non-streaming callers.
    route_background_tasks: v.optional(v.boolean(), true),
    global_default_model: v.string("global_default_model is required"),
    semantic: v.optional(SemanticSchema),
    personas: v.record(v.string(), PersonaSchema),
    catalog: v.record(v.string(), ModelSchema),
    //  Off unless the operator says so. The decision log is a plain
    //  SQLite file: anyone who can read it reads every prompt, and
    //  the operator always can. Hashes group repeats without text.
    log_prompts: v.optional(v.boolean(), false),
    //  Off unless the operator says so. Open WebUI's user headers name
    //  the person at the keyboard; a local backend ignores them, and a
    //  backend that meters per user can be given them. One switch for
    //  every route that forwards to the backend.
    forward_user_headers: v.optional(v.boolean(), false),
    client_names: v.optional(v.record(v.string(), v.string()), {}),
    //  Keyed by client signature, as client_names is. A client that
    //  cannot be told to send a field itself, such as a phone
    //  keyboard, gets it here. The request's own value always wins.
    client_defaults: v.optional(
        v.record(
            v.pipe(
                v.string(),
                v.regex(
                    CLIENT_SIGNATURE,
                    "a client signature is lowercase, such as 'leantype'",
                ),
            ),
            ClientDefaultsSchema,
        ),
        {},
    ),
    //  Every user message gets a note saying when it was first seen,
    //  in the user's zone. Applied on save, like client_defaults.
    message_prefix: v.optional(MessagePrefixSchema, {}),
    log_path: v.optional(v.string()),
    memory: v.optional(MemorySchema, {}),
    //  Empty unless the operator names one, and then every proxied
    //  request is still refused unless it fits that proxy exactly and
    //  carries the API token (config/token.js).
    trusted_proxies: v.optional(v.array(TrustedProxySchema), []),
    //  Browser extensions that may call Saxby, each by its exact
    //  origin. Empty by default: every request from a browser is
    //  refused. A browser sets Origin itself, so a web page cannot
    //  claim to be an extension.
    allowed_origins: v.optional(
        v.array(
            v.pipe(
                v.string(),
                v.regex(
                    EXTENSION_ORIGIN,
                    "an origin must be one browser extension, such as " +
                        "'chrome-extension://<id>', with no wildcard",
                ),
            ),
        ),
        [],
    ),
});

/**
 * Asserts referential integrity across the config object.
 * Ensures all referenced models actually exist in the catalog.
 */
function validateReferentialIntegrity(config) {
    const catalogKeys = new Set(Object.keys(config.catalog));

    // 1. Check global_default_model
    if (!catalogKeys.has(config.global_default_model)) {
        throw new Error(
            `global_default_model '${config.global_default_model}' ` +
                `is not in the catalog`,
        );
    }

    // 2. Check each persona's default_model
    for (const [personaName, persona] of Object.entries(config.personas)) {
        if (!catalogKeys.has(persona.default_model)) {
            throw new Error(
                `personas.${personaName}.default_model ` +
                    `'${persona.default_model}' is not in the catalog`,
            );
        }
    }

    // 3. Check semantic active profile
    if (config.semantic && config.semantic.active) {
        if (!config.semantic.profiles[config.semantic.active]) {
            throw new Error(
                `semantic.active '${config.semantic.active}' is not ` +
                    `one of semantic.profiles`,
            );
        }
    }
}

/**
 * One readable line per valibot issue. The raw issue objects name an
 * unknown field "Expected never but received 1" and bury the field
 * name in a nested path dump.
 */
function describeIssue(issue) {
    const path = (issue.path || []).map((item) => item.key).join(".");

    if (issue.type === "strict_object") {
        return `unknown field '${path}' — check the spelling`;
    }

    if (!path) {
        return issue.message;
    }

    return `${path}: ${issue.message}`;
}

/**
 * Validates a raw config object against schema and integrity rules.
 * Prints nothing; throws one Error listing every problem, one per
 * line, for the loader to attach the file path to.
 */
export function validateConfig(rawConfig) {
    const result = v.safeParse(SaxbyConfigSchema, rawConfig);

    if (!result.success) {
        const lines = result.issues.map((issue) => `- ${describeIssue(issue)}`);

        throw new Error(lines.join("\n"));
    }

    try {
        validateReferentialIntegrity(result.output);
    } catch (err) {
        throw new Error(`- ${err.message}`);
    }

    return result.output;
}
