//  =====================================================================
//  Request guard
//  =====================================================================
//  Saxby listens on loopback only and checks no credentials, so it
//  must be sure every request really comes from a local, non-browser
//  client. Three ways that assumption breaks, each refused here before
//  any route runs:
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
//  proxied request is refused as before. Saxby still checks no
//  credentials, so a named proxy decides who gets in. Saxby checks
//  only that the request fits that proxy and nothing else.
//
//  A header cannot prove which proxy sent it: every connection here
//  is from 127.0.0.1, and a program on this machine can send any
//  header it likes. That program could already call Saxby directly,
//  so the checks below are about strangers, not about it.
//
//  Pure: a request in, a refusal or null out. Wired in by main.js.

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

//  Where a proxy on this machine connects from.
const LOOPBACK = new Set(["127.0.0.1", "::1"]);

//  All a proxied client may reach. Everything else stays local: the
//  memory broker, the status route with its pid, and the catch-all
//  that passes Ollama's own API through.
const PROXIED_CHAT = { method: "POST", path: "/v1/chat/completions" };
const PROXIED_MODELS = { method: "GET", path: "/v1/models" };

//  Names a local client uses to reach Saxby. host.docker.internal is
//  how a Docker Desktop container reaches the host; Niko's Open WebUI
//  sends it. Ports are ignored: the listener decides the port.
const ALLOWED_HOSTS = new Set([
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

function isProxiedRoute(method, path) {
    if (method === PROXIED_CHAT.method) {
        return path === PROXIED_CHAT.path;
    }

    if (method !== PROXIED_MODELS.method) {
        return false;
    }

    if (path === PROXIED_MODELS.path) {
        return true;
    }

    return path.startsWith(`${PROXIED_MODELS.path}/`);
}

function refusal(status, code, message) {
    return { status, code, message };
}

function notTrusted(message) {
    return refusal(403, "proxy_not_trusted", `${message} ${DOCS_HINT}`);
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
    if (!LOOPBACK.has(remoteHostname)) {
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
    const hostname = hostnameOf(host);

    const named = trustedProxies.some((proxy) =>
        proxy.host.toLowerCase() === hostname
    );

    if (!named) {
        return notTrusted(
            `Refused: Host '${host}' is not a proxy named in ` +
                `trusted_proxies.`,
        );
    }

    const forwardedFor = headers.get("x-forwarded-for") ?? "";

    if (!isTailnetAddress(forwardedFor)) {
        return notTrusted(
            `Refused: x-forwarded-for '${forwardedFor}' is not one ` +
                `tailnet address, so the request did not come through ` +
                `Tailscale Serve alone.`,
        );
    }

    if (!isProxiedRoute(method, path)) {
        return refusal(
            403,
            "proxy_path_not_allowed",
            `Refused: '${method} ${path}' is not served through a ` +
                `proxy. Proxied clients get /v1/chat/completions and ` +
                `/v1/models. ${DOCS_HINT}`,
        );
    }

    return null;
}

/**
 * Decides whether a request may proceed.
 * @param {{ headers: Headers, path: string, method?: string,
 *     remoteHostname?: string,
 *     trustedProxies?: { kind: string, host: string }[] }} request
 *     method and remoteHostname are read only for a proxied request;
 *     trustedProxies is the config's list, empty when left out.
 * @returns {{ status: number, code: string, message: string } | null}
 *     null to allow; otherwise what to refuse with.
 */
export function inspectRequest(request) {
    const { headers, path } = request;
    const trustedProxies = request.trustedProxies ?? [];
    const proxyHeader = findProxyHeader(headers);

    if (proxyHeader) {
        if (trustedProxies.length === 0) {
            return refusal(
                403,
                "proxy_attribution_required",
                `Refused: the request carries '${proxyHeader}', so it ` +
                    `came through a proxy. Saxby only serves clients ` +
                    `on this machine directly. ${DOCS_HINT}`,
            );
        }
    }

    const origin = headers.get("origin");

    if (origin !== null) {
        return refusal(
            403,
            "origin_not_allowed",
            `Refused: the request came from a web page (Origin ` +
                `'${origin}'). Saxby does not serve browsers. ` +
                DOCS_HINT,
        );
    }

    //  Everything below is about local names, which a proxied request
    //  never carries. It has its own checks, and passes or fails there.
    if (proxyHeader) {
        return inspectProxied(request, trustedProxies);
    }

    const host = headers.get("host");

    if (host === null) {
        return refusal(
            403,
            "host_not_allowed",
            `Refused: the request has no Host header. ${DOCS_HINT}`,
        );
    }

    if (!ALLOWED_HOSTS.has(hostnameOf(host))) {
        return refusal(
            403,
            "host_not_allowed",
            `Refused: Host '${host}' is not a local name. Use ` +
                `127.0.0.1 or localhost. ${DOCS_HINT}`,
        );
    }

    if (isManagementPath(path)) {
        return refusal(
            403,
            "management_not_allowed",
            `Refused: '${path}' manages Ollama's models and is not ` +
                `served through Saxby. Call Ollama directly. ${DOCS_HINT}`,
        );
    }

    return null;
}
