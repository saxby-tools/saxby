//  =====================================================================
//  Request guard
//  =====================================================================
//  Saxby asks nothing of a local, non-browser client, so it must be
//  sure which requests really are one. Three ways that assumption
//  breaks, each refused here before any route runs:
//
//    a proxy on the same machine   Caddy or `tailscale serve` forwards
//                                  strangers, and every request then
//                                  arrives from 127.0.0.1. Proxies mark
//                                  themselves with forwarding headers.
//    a web page in your browser    any site can send requests to
//                                  127.0.0.1. Browsers mark them with
//                                  an Origin header.
//    DNS rebinding                 a site points its own hostname at
//                                  127.0.0.1 to read the answers. The
//                                  Host header still names that site.
//
//  Ollama's model-management API is refused too: nothing needs to pull
//  or delete models through a router.
//
//  Only Origin and Host decide "browser". Never Sec-Fetch-*: Node's
//  built-in fetch sends `sec-fetch-mode: cors` from server code, and
//  OpenClaw's real requests carry it.
//
//  One way in from another machine: a proxy the operator names in
//  `trusted_proxies`. The list is empty by default, and then every
//  proxied request is refused as before. Saxby checks that a proxied
//  request fits that proxy and nothing else.
//
//  A header cannot prove which proxy sent it: every connection here
//  is from 127.0.0.1, and a program on this machine can send any
//  header it likes. That is what the API token is for. A request
//  that does not come STRAIGHT from this machine, meaning a loopback
//  connection with no forwarding header, must carry the instance's
//  token (core's config/token.js). Local clients never need it. The
//  token is checked before anything else is said, so a caller without
//  it learns nothing about how this Saxby is set up.
//
//  One way in from a browser: an extension whose exact origin the
//  operator lists in `allowed_origins`. A browser sets Origin itself,
//  so a web page cannot claim an extension's. Web pages are never let
//  in: they would also need CORS answers, which Saxby does not give.
//
//  Pure: a request in, a refusal or null out, plus who called when
//  the request came through a trusted proxy, for the decision log.
//  Wired in by main.js.

import { EXTENSION_ORIGIN } from "@saxby/core";

//  Headers proxies add to say who the real caller was. HTTP requires a
//  proxy to add Via; the rest are the common vendor forms.
const PROXY_HEADERS = [
    "forwarded",
    "via",
    "x-real-ip",
    "x-client-ip",
    "true-client-ip",
    "cf-connecting-ip",
];

const PROXY_HEADER_PREFIX = "x-forwarded-";

//  All that `tailscale serve` adds to say who called (Tailscale's
//  ipn/ipnlocal/serve.go, read at v1.102.2). Any other forwarding
//  header means a second proxy sits in the chain.
const SERVE_HEADERS = new Set([
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
]);

//  Serve sets this on traffic from the public internet (Funnel) and
//  removes a client's own copy first, so finding it settles it.
const FUNNEL_HEADER = "tailscale-funnel-request";

//  Serve names the person a device belongs to in this header, and
//  removes a client's own copy first. A tagged device gets none. Read
//  only once a request has passed every proxy check: on a direct
//  request a local program could have sent it. The display name and
//  profile picture Serve sends beside it are never read.
const SERVE_LOGIN_HEADER = "tailscale-user-login";

const FORWARDED_FOR_HEADER = "x-forwarded-for";

//  Every tailnet device has an address in 100.64.0.0/10 or in
//  fd7a:115c:a1e0::/48. Serve overwrites X-Forwarded-For with the
//  caller's, so anything else did not come through Serve alone.
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_CHARS = /^[0-9a-f:]+$/;
const OCTET_MAX = 255;
const TAILNET_V4_FIRST = 100;
const TAILNET_V4_SECOND_MIN = 64;
const TAILNET_V4_SECOND_MAX = 127;
const TAILNET_V6_PREFIX = "fd7a:115c:a1e0:";

//  A connection from this machine: all of 127.0.0.0/8, ::1, and an
//  IPv4 loopback address as a dual-stack listener reports it,
//  "::ffff:127.0.0.1".
const LOOPBACK_V4_PREFIX = "127.";
const LOOPBACK_V6 = "::1";
const MAPPED_V4_PREFIX = "::ffff:";

//  All a client that is not on this machine may reach, and a browser
//  extension too. Everything else stays with local programs: the
//  memory broker and the catch-all that passes Ollama's own API
//  through.
const CLIENT_CHAT = { method: "POST", path: "/v1/chat/completions" };
const CLIENT_MODELS = { method: "GET", path: "/v1/models" };
const CLIENT_ROUTES_HINT = "/v1/chat/completions and /v1/models";

//  One more for a direct connection from another address: the status
//  route. `saxby` asks it where saxbyd listens, and when that is one
//  interface and not loopback, its own request arrives from that
//  interface's address. A proxied client and an extension never get
//  it.
const REMOTE_STATUS = { method: "GET", path: "/saxby/v1/status" };

//  Names a local client uses to reach Saxby. host.docker.internal is
//  how a Docker Desktop container reaches the host; Niko's Open WebUI
//  sends it. Ports are ignored: the listener decides the port. The
//  config's allowed_hosts adds to this set (buildAllowedHosts), for a
//  Compose service name or Podman's host.containers.internal.
const LOCAL_HOSTS = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    "host.docker.internal",
]);

//  Ollama's model-management endpoints. /api/blobs uploads files for
//  /api/create.
const MANAGEMENT_PATHS = [
    "/api/pull",
    "/api/push",
    "/api/create",
    "/api/copy",
    "/api/delete",
    "/api/blobs",
];

const DOCS_HINT = "See docs/troubleshooting.md.";

//  How the caller's token compares with this instance's. main.js
//  works it out (security/token.js) so this file stays pure.

/** Token state: the caller sent this instance's token. */
export const TOKEN_VALID = "valid";

/** Token state: the caller sent a token, and it is not this one. */
export const TOKEN_INVALID = "invalid";

/**
 * Token state: the caller sent no token. The default, so a request
 * nobody classified is treated as a stranger.
 */
export const TOKEN_MISSING = "missing";

/**
 * Token state: saxbyd could not read its own token file. Then nothing
 * can be checked, and only local clients are served.
 */
export const TOKEN_UNAVAILABLE = "unavailable";

const TOKEN_HINT = "Run 'saxby token' on the machine running Saxby " +
    "to see it.";

function findProxyHeader(headers) {
    for (const name of headers.keys()) {
        if (name.startsWith(PROXY_HEADER_PREFIX)) {
            return name;
        }

        if (PROXY_HEADERS.includes(name)) {
            return name;
        }
    }

    return null;
}

/**
 * Finds a forwarding header that Tailscale Serve does not send.
 */
function findStrayProxyHeader(headers) {
    for (const name of headers.keys()) {
        if (SERVE_HEADERS.has(name)) {
            continue;
        }

        if (name.startsWith(PROXY_HEADER_PREFIX)) {
            return name;
        }

        if (PROXY_HEADERS.includes(name)) {
            return name;
        }
    }

    return null;
}

//  "Example.com:443" -> "example.com", "[::1]:11435" -> "[::1]".
function hostnameOf(host) {
    const value = host.trim().toLowerCase();

    if (value.startsWith("[")) {
        const end = value.indexOf("]");

        return end === -1 ? value : value.slice(0, end + 1);
    }

    return value.split(":")[0];
}

/**
 * The Host names the guard accepts: the local names plus the config's
 * allowed_hosts, read the same way a Host header is, so "Saxby:11435"
 * in the config matches "saxby" on the wire.
 * @param {string[]} [extra] - config.allowed_hosts
 * @returns {Set<string>}
 */
export function buildAllowedHosts(extra = []) {
    return new Set([...LOCAL_HOSTS, ...extra.map(hostnameOf)]);
}

function isManagementPath(path) {
    return MANAGEMENT_PATHS.some((prefix) =>
        path === prefix || path.startsWith(`${prefix}/`)
    );
}

function isTailnetV4(address) {
    const match = address.match(IPV4);

    if (!match) {
        return false;
    }

    const octets = match.slice(1).map(Number);

    if (octets.some((octet) => octet > OCTET_MAX)) {
        return false;
    }

    if (octets[0] !== TAILNET_V4_FIRST) {
        return false;
    }

    if (octets[1] < TAILNET_V4_SECOND_MIN) {
        return false;
    }

    return octets[1] <= TAILNET_V4_SECOND_MAX;
}

function isTailnetV6(address) {
    if (!IPV6_CHARS.test(address)) {
        return false;
    }

    return address.startsWith(TAILNET_V6_PREFIX);
}

/**
 * True for exactly one tailnet address. "a, b" is two, which is what
 * a second proxy in the chain leaves behind.
 */
function isTailnetAddress(value) {
    const address = value.trim().toLowerCase();

    if (isTailnetV4(address)) {
        return true;
    }

    return isTailnetV6(address);
}

function isClientRoute(method, path) {
    if (method === CLIENT_CHAT.method) {
        return path === CLIENT_CHAT.path;
    }

    if (method !== CLIENT_MODELS.method) {
        return false;
    }

    if (path === CLIENT_MODELS.path) {
        return true;
    }

    return path.startsWith(`${CLIENT_MODELS.path}/`);
}

function refusal(status, code, message) {
    return { status, code, message };
}

/**
 * Whether a connection's address is this machine's loopback. The
 * address comes from the socket, never from a header. Anything that
 * is not plainly loopback, an unknown address included, is not.
 * @param {string | undefined} remoteHostname
 * @returns {boolean}
 */
function isLoopbackAddress(remoteHostname) {
    if (typeof remoteHostname !== "string") {
        return false;
    }

    let address = remoteHostname.toLowerCase();

    if (address === LOOPBACK_V6) {
        return true;
    }

    if (address.startsWith(MAPPED_V4_PREFIX)) {
        address = address.slice(MAPPED_V4_PREFIX.length);
    }

    if (!IPV4.test(address)) {
        return false;
    }

    return address.startsWith(LOOPBACK_V4_PREFIX);
}

/**
 * Whether a request comes straight from this machine: a loopback
 * connection that no proxy forwarded.
 */
function isDirect(remoteHostname, proxyHeader) {
    if (proxyHeader) {
        return false;
    }

    return isLoopbackAddress(remoteHostname);
}

function isRemoteRoute(method, path) {
    if (isClientRoute(method, path)) {
        return true;
    }

    if (method !== REMOTE_STATUS.method) {
        return false;
    }

    return path === REMOTE_STATUS.path;
}

/**
 * Judges the token of a request that is not straight from this
 * machine. The messages say nothing about this Saxby's config.
 * @param {string} tokenState - one of the TOKEN_ constants
 * @returns {{ status: number, code: string, message: string } | null}
 */
function inspectToken(tokenState) {
    if (tokenState === TOKEN_VALID) {
        return null;
    }

    if (tokenState === TOKEN_UNAVAILABLE) {
        return refusal(
            403,
            "token_unavailable",
            `Refused: this Saxby could not read its API token file, ` +
                `so it serves only the machine it runs on. Its log ` +
                `says why. ${DOCS_HINT}`,
        );
    }

    if (tokenState === TOKEN_INVALID) {
        return refusal(
            401,
            "token_invalid",
            `Refused: that is not this Saxby's API token. ` +
                `${TOKEN_HINT} ${DOCS_HINT}`,
        );
    }

    return refusal(
        401,
        "token_required",
        `Refused: this request did not come straight from the machine ` +
            `running Saxby, so it needs the API token, sent as ` +
            `'Authorization: Bearer <token>'. ${TOKEN_HINT} ${DOCS_HINT}`,
    );
}

function notTrusted(message) {
    return refusal(403, "proxy_not_trusted", `${message} ${DOCS_HINT}`);
}

/**
 * The trusted proxy a request's Host names, or null.
 * @param {string} hostname - as hostnameOf reads it
 * @param {{ kind: string, host: string }[]} trustedProxies
 * @returns {{ kind: string, host: string } | null}
 */
function findNamedProxy(hostname, trustedProxies) {
    const named = trustedProxies.find((proxy) =>
        proxy.host.toLowerCase() === hostname
    );

    return named ?? null;
}

/**
 * Judges a request that carries forwarding headers, once the operator
 * has named a proxy. Every check must pass; the request is refused
 * at the first that does not.
 * @param {{ headers: Headers, path: string, method?: string,
 *     remoteHostname?: string }} request
 * @param {{ kind: string, host: string }[]} trustedProxies
 * @returns {{ status: number, code: string, message: string } | null}
 */
function inspectProxied(request, trustedProxies) {
    const { headers, path, method, remoteHostname } = request;

    //  True of every connection today, since Saxby listens on loopback
    //  only. Checked so that a later non-loopback listener cannot
    //  inherit this trust by accident.
    if (!isLoopbackAddress(remoteHostname)) {
        return notTrusted(
            `Refused: a proxied request must reach Saxby from this ` +
                `machine, and this one came from ` +
                `'${remoteHostname ?? "unknown"}'.`,
        );
    }

    if (headers.has(FUNNEL_HEADER)) {
        return notTrusted(
            `Refused: the request came from the public internet ` +
                `through Tailscale Funnel. Saxby serves your tailnet ` +
                `only.`,
        );
    }

    const stray = findStrayProxyHeader(headers);

    if (stray) {
        return notTrusted(
            `Refused: the request carries '${stray}', which Tailscale ` +
                `Serve does not send, so another proxy is in the chain.`,
        );
    }

    const host = headers.get("host") ?? "";
    const named = findNamedProxy(hostnameOf(host), trustedProxies);

    if (named === null) {
        return notTrusted(
            `Refused: Host '${host}' is not a proxy named in ` +
                `trusted_proxies.`,
        );
    }

    const forwardedFor = headers.get(FORWARDED_FOR_HEADER) ?? "";

    if (!isTailnetAddress(forwardedFor)) {
        return notTrusted(
            `Refused: x-forwarded-for '${forwardedFor}' is not one ` +
                `tailnet address, so the request did not come through ` +
                `Tailscale Serve alone.`,
        );
    }

    if (!isClientRoute(method, path)) {
        return refusal(
            403,
            "proxy_path_not_allowed",
            `Refused: '${method} ${path}' is not served through a ` +
                `proxy. Proxied clients get ${CLIENT_ROUTES_HINT}. ` +
                DOCS_HINT,
        );
    }

    return null;
}

/**
 * What the guard established about a caller, once inspectProxied has
 * passed the request: which proxy it came through, the login Serve
 * attached, or null for a tagged device, and the one tailnet address
 * Serve wrote. Only the decision log reads this, and only the kind
 * is stored unless `log_proxy_users` says otherwise (log/db.js).
 * @param {Headers} headers
 * @param {{ kind: string, host: string }[]} trustedProxies
 * @returns {{ kind: string, user: string | null, addr: string }}
 */
function describeProxyCaller(headers, trustedProxies) {
    const hostname = hostnameOf(headers.get("host") ?? "");
    const named = findNamedProxy(hostname, trustedProxies);

    return {
        kind: named.kind,
        user: headers.get(SERVE_LOGIN_HEADER),
        addr: (headers.get(FORWARDED_FOR_HEADER) ?? "").trim(),
    };
}

/**
 * Judges a request that carries an Origin header, which only a
 * browser sends. Null lets it go on to the checks every request gets.
 * @param {string} origin
 * @param {{ path: string, method?: string }} request
 * @param {string[]} allowedOrigins
 * @returns {{ status: number, code: string, message: string } | null}
 */
function inspectOrigin(origin, request, allowedOrigins) {
    const { method, path } = request;
    const claimed = origin.toLowerCase();

    if (allowedOrigins.includes(claimed)) {
        if (isClientRoute(method, path)) {
            return null;
        }

        return refusal(
            403,
            "origin_path_not_allowed",
            `Refused: '${method} ${path}' is not served to a browser ` +
                `extension. Extensions get ${CLIENT_ROUTES_HINT}. ` +
                DOCS_HINT,
        );
    }

    //  Says what to add, since the fix is one config line and the
    //  origin in hand is the exact value it needs.
    if (EXTENSION_ORIGIN.test(claimed)) {
        return refusal(
            403,
            "origin_not_allowed",
            `Refused: the browser extension '${origin}' is not in ` +
                `allowed_origins. Add that origin to the config to ` +
                `let it in. ${DOCS_HINT}`,
        );
    }

    return refusal(
        403,
        "origin_not_allowed",
        `Refused: the request came from a web page (Origin ` +
            `'${origin}'). Saxby does not serve browsers. ` +
            DOCS_HINT,
    );
}

//  A judgement with nothing to say about the caller: every refusal,
//  and every allowed request that did not come through a proxy.
function withoutCaller(verdict) {
    return { verdict, proxyCaller: null };
}

/**
 * Decides whether a request may proceed, and says what the guard
 * established about who sent it.
 * @param {{ headers: Headers, path: string, method?: string,
 *     remoteHostname?: string,
 *     trustedProxies?: { kind: string, host: string }[],
 *     allowedOrigins?: string[], tokenState?: string,
 *     allowedHosts?: Set<string> }} request
 *     method is read only for a proxied or browser request;
 *     trustedProxies and allowedOrigins are the config's lists, empty
 *     when left out. allowedHosts comes from buildAllowedHosts and is
 *     the local names alone when left out. tokenState is one of the
 *     TOKEN_ constants and
 *     counts as missing when left out, as an unknown remoteHostname
 *     counts as another machine: both fail closed.
 * @returns {{ verdict: { status: number, code: string,
 *     message: string } | null,
 *     proxyCaller: { kind: string, user: string | null,
 *     addr: string } | null }}
 *     verdict is null to allow; otherwise what to refuse with.
 *     proxyCaller is set for an allowed request that came through a
 *     trusted proxy, and null for every other, a direct request that
 *     sends Serve's own headers included: on a loopback connection
 *     with no forwarding header, nothing in those headers is trusted.
 */
export function judgeRequest(request) {
    const { headers, path } = request;
    const trustedProxies = request.trustedProxies ?? [];
    const allowedOrigins = request.allowedOrigins ?? [];
    const tokenState = request.tokenState ?? TOKEN_MISSING;
    const allowedHosts = request.allowedHosts ?? LOCAL_HOSTS;
    const proxyHeader = findProxyHeader(headers);

    if (proxyHeader) {
        if (trustedProxies.length === 0) {
            return withoutCaller(refusal(
                403,
                "proxy_attribution_required",
                `Refused: the request carries '${proxyHeader}', so it ` +
                    `came through a proxy. Saxby only serves clients ` +
                    `on this machine directly. ${DOCS_HINT}`,
            ));
        }
    }

    const direct = isDirect(request.remoteHostname, proxyHeader);

    if (!direct) {
        const verdict = inspectToken(tokenState);

        if (verdict) {
            return withoutCaller(verdict);
        }
    }

    const origin = headers.get("origin");

    if (origin !== null) {
        const verdict = inspectOrigin(origin, request, allowedOrigins);

        if (verdict) {
            return withoutCaller(verdict);
        }
    }

    //  Everything below is about local names, which a proxied request
    //  never carries. It has its own checks, and passes or fails there.
    if (proxyHeader) {
        const verdict = inspectProxied(request, trustedProxies);

        if (verdict) {
            return withoutCaller(verdict);
        }

        return {
            verdict: null,
            proxyCaller: describeProxyCaller(headers, trustedProxies),
        };
    }

    //  A connection from another address, token in hand. The token
    //  says the caller is allowed in, not that it is a local program,
    //  so it gets the client routes and not the whole surface.
    if (!direct) {
        if (!isRemoteRoute(request.method, path)) {
            return withoutCaller(refusal(
                403,
                "remote_path_not_allowed",
                `Refused: '${request.method} ${path}' is served only ` +
                    `to programs on the machine running Saxby. Other ` +
                    `machines get ${CLIENT_ROUTES_HINT}. ${DOCS_HINT}`,
            ));
        }
    }

    const host = headers.get("host");

    if (host === null) {
        return withoutCaller(refusal(
            403,
            "host_not_allowed",
            `Refused: the request has no Host header. ${DOCS_HINT}`,
        ));
    }

    if (!allowedHosts.has(hostnameOf(host))) {
        return withoutCaller(refusal(
            403,
            "host_not_allowed",
            `Refused: Host '${host}' is not a local name. Use ` +
                `127.0.0.1 or localhost, or add it to allowed_hosts ` +
                `in config.jsonc. ${DOCS_HINT}`,
        ));
    }

    if (isManagementPath(path)) {
        return withoutCaller(refusal(
            403,
            "management_not_allowed",
            `Refused: '${path}' manages Ollama's models and is not ` +
                `served through Saxby. Call Ollama directly. ${DOCS_HINT}`,
        ));
    }

    return withoutCaller(null);
}

/**
 * Decides whether a request may proceed: judgeRequest's verdict alone.
 * @param {Parameters<typeof judgeRequest>[0]} request
 * @returns {{ status: number, code: string, message: string } | null}
 *     null to allow; otherwise what to refuse with.
 */
export function inspectRequest(request) {
    return judgeRequest(request).verdict;
}
