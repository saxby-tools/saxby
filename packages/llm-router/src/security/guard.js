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
//  Pure: headers in, a refusal or null out. Wired in by main.js.

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

function refusal(status, code, message) {
    return { status, code, message };
}

/**
 * Decides whether a request may proceed.
 * @param {{ headers: Headers, path: string }} request
 * @returns {{ status: number, code: string, message: string } | null}
 *     null to allow; otherwise what to refuse with.
 */
export function inspectRequest({ headers, path }) {
    const proxyHeader = findProxyHeader(headers);

    if (proxyHeader) {
        return refusal(
            403,
            "proxy_attribution_required",
            `Refused: the request carries '${proxyHeader}', so it came ` +
                `through a proxy. Saxby only serves clients on this ` +
                `machine directly. ${DOCS_HINT}`,
        );
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
