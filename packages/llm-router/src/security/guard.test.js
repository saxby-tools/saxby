import { assertEquals } from "@std/assert";
import { inspectRequest } from "./guard.js";

//  Header names and Host values captured from real clients on
//  2026-10-25 (tcpdump on lo0). Personal values are replaced. These
//  must always pass: a guard that locks out the clients it protects is
//  worse than no guard.
const OPEN_WEBUI = {
    "host": "host.docker.internal:11435",
    "content-type": "application/json",
    "x-openwebui-auth-type": "jwt",
    "x-openwebui-user-name": "Someone",
    "x-openwebui-user-id": "00000000-0000-0000-0000-000000000000",
    "x-openwebui-user-email": "someone@example.com",
    "x-openwebui-user-role": "admin",
    "x-openwebui-chat-id": "00000000-0000-0000-0000-000000000000",
    "authorization": "Bearer placeholder",
    "accept": "*/*",
    "accept-encoding": "gzip, deflate, br",
    "user-agent": "Python/3.11 aiohttp/3.14.3",
};

const OPENCLAW = {
    "host": "127.0.0.1:11435",
    "connection": "keep-alive",
    "accept": "application/json",
    "authorization": "Bearer placeholder",
    "content-type": "application/json",
    "traceparent": "00-00000000000000000000000000000000-0000000000000000-01",
    "user-agent": "OpenAI/JS 7.20.0",
    "x-stainless-lang": "js",
    "x-stainless-runtime": "node",
    "accept-language": "*",
    "sec-fetch-mode": "cors",
    "accept-encoding": "gzip, deflate",
};

const CURL = { "host": "127.0.0.1:11435", "user-agent": "curl/8.7.1" };

function inspect(headers, path = "/v1/chat/completions") {
    return inspectRequest({ headers: new Headers(headers), path });
}

function codeFor(headers, path) {
    return inspect(headers, path)?.code ?? null;
}

Deno.test("guard — Niko's Open WebUI passes", () => {
    assertEquals(inspect(OPEN_WEBUI), null);
});

Deno.test("guard — Niko's OpenClaw passes, sec-fetch-mode and all", () => {
    assertEquals(inspect(OPENCLAW), null);
});

Deno.test("guard — local names pass, with or without a port", () => {
    for (const host of ["localhost", "127.0.0.1:11436", "[::1]:11435"]) {
        assertEquals(inspect({ host }), null, host);
    }
});

Deno.test("guard — forwarding headers mean a proxy: refused", () => {
    const headers = [
        "x-forwarded-for",
        "x-forwarded-proto",
        "forwarded",
        "via",
        "x-real-ip",
        "true-client-ip",
        "cf-connecting-ip",
        "x-client-ip",
    ];

    for (const name of headers) {
        assertEquals(
            codeFor({ ...CURL, [name]: "203.0.113.7" }),
            "proxy_attribution_required",
            name,
        );
    }
});

Deno.test("guard — any Origin means a browser: refused", () => {
    for (const origin of ["https://evil.example", "null", "http://localhost"]) {
        assertEquals(
            codeFor({ ...CURL, origin }),
            "origin_not_allowed",
            origin,
        );
    }
});

Deno.test("guard — a foreign Host means DNS rebinding: refused", () => {
    for (const host of ["attacker.example", "neeks-mbp.ts.net:443"]) {
        assertEquals(codeFor({ host }), "host_not_allowed", host);
    }
});

Deno.test("guard — a missing Host is refused", () => {
    assertEquals(codeFor({ "user-agent": "x" }), "host_not_allowed");
});

Deno.test("guard — Ollama's management paths are refused", () => {
    const paths = [
        "/api/pull",
        "/api/push",
        "/api/create",
        "/api/copy",
        "/api/delete",
        "/api/blobs/sha256:abc",
    ];

    for (const path of paths) {
        assertEquals(codeFor(CURL, path), "management_not_allowed", path);
    }
});

Deno.test("guard — Ollama's read paths still pass", () => {
    for (const path of ["/api/tags", "/api/show", "/api/version"]) {
        assertEquals(codeFor(CURL, path), null, path);
    }
});

Deno.test("guard — a lookalike path is not a management path", () => {
    assertEquals(codeFor(CURL, "/api/pullout"), null);
});

//  =====================================================================
//  Trusted proxies
//  =====================================================================

//  What Tailscale Serve forwards for a phone on the tailnet. The
//  proxy's own headers are from Tailscale's source (serve.go at
//  v1.102.2), NOT from a capture (issue #51). The User-Agent is the
//  LeanType keyboard's, as the decision log recorded it; its other
//  headers are a guess.
const SERVE_HOST = "box.example.ts.net";

const SERVE = {
    "host": `${SERVE_HOST}:11435`,
    "user-agent": "LeanType/1.0",
    "authorization": "Bearer placeholder",
    "content-type": "application/json",
    "accept-encoding": "gzip",
    "x-forwarded-host": `${SERVE_HOST}:11435`,
    "x-forwarded-proto": "https",
    "x-forwarded-for": "100.64.0.7",
    "tailscale-user-login": "someone@example.com",
    "tailscale-user-name": "Someone",
    "tailscale-user-profile-pic": "https://example.com/pic.png",
    "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
};

const TRUSTED = [{ kind: "tailscale-serve", host: SERVE_HOST }];

function inspectProxied(headers, overrides = {}) {
    return inspectRequest({
        headers: new Headers(headers),
        path: "/v1/chat/completions",
        method: "POST",
        remoteHostname: "127.0.0.1",
        trustedProxies: TRUSTED,
        ...overrides,
    });
}

function proxiedCode(headers, overrides) {
    return inspectProxied(headers, overrides)?.code ?? null;
}

Deno.test("proxy — with none named, Serve is refused as before", () => {
    const verdict = inspectProxied(SERVE, { trustedProxies: [] });

    assertEquals(verdict.status, 403);
    assertEquals(verdict.code, "proxy_attribution_required");
});

Deno.test("proxy — a config without the field refuses Serve too", () => {
    assertEquals(inspect(SERVE)?.code, "proxy_attribution_required");
});

Deno.test("proxy — a named Serve passes for chat", () => {
    assertEquals(inspectProxied(SERVE), null);
});

Deno.test("proxy — a tagged device, with no identity headers, passes", () => {
    const tagged = { ...SERVE };

    delete tagged["tailscale-user-login"];
    delete tagged["tailscale-user-name"];
    delete tagged["tailscale-user-profile-pic"];
    delete tagged["tailscale-headers-info"];

    assertEquals(inspectProxied(tagged), null);
});

Deno.test("proxy — a tailnet IPv6 address passes", () => {
    const headers = { ...SERVE, "x-forwarded-for": "fd7a:115c:a1e0::7" };

    assertEquals(inspectProxied(headers), null);
});

Deno.test("proxy — the host's case and port do not matter", () => {
    const headers = { ...SERVE, "host": "Box.Example.TS.net" };

    assertEquals(inspectProxied(headers), null);
});

Deno.test("proxy — a proxy that is not the named one is refused", () => {
    const hosts = [
        "other.example.ts.net:11435",
        "caddy.example.com",
        "127.0.0.1:11435",
    ];

    for (const host of hosts) {
        assertEquals(
            proxiedCode({ ...SERVE, host }),
            "proxy_not_trusted",
            host,
        );
    }
});

Deno.test("proxy — a missing Host is refused", () => {
    const headers = { ...SERVE };

    delete headers.host;

    assertEquals(proxiedCode(headers), "proxy_not_trusted");
});

Deno.test("proxy — a header Serve never sends is refused", () => {
    const strays = [
        "via",
        "forwarded",
        "x-real-ip",
        "cf-connecting-ip",
        "x-forwarded-port",
    ];

    for (const name of strays) {
        assertEquals(
            proxiedCode({ ...SERVE, [name]: "203.0.113.7" }),
            "proxy_not_trusted",
            name,
        );
    }
});

Deno.test("proxy — Funnel traffic is refused", () => {
    const headers = { ...SERVE, "tailscale-funnel-request": "?1" };

    assertEquals(proxiedCode(headers), "proxy_not_trusted");
});

Deno.test("proxy — a caller outside the tailnet is refused", () => {
    const callers = [
        "203.0.113.7",
        "100.63.255.255",
        "100.128.0.1",
        "100.64.0.999",
        "192.168.1.20",
        "127.0.0.1",
        "2001:db8::1",
        "fd7a:115c:a1e0:<x>",
        "100.64.0.7, 100.64.0.8",
        "",
    ];

    for (const caller of callers) {
        assertEquals(
            proxiedCode({ ...SERVE, "x-forwarded-for": caller }),
            "proxy_not_trusted",
            caller,
        );
    }
});

Deno.test("proxy — a missing x-forwarded-for is refused", () => {
    const headers = { ...SERVE };

    delete headers["x-forwarded-for"];

    assertEquals(proxiedCode(headers), "proxy_not_trusted");
});

Deno.test("proxy — a connection from off this machine is refused", () => {
    for (const remoteHostname of ["192.168.1.20", "100.64.0.7", undefined]) {
        assertEquals(
            proxiedCode(SERVE, { remoteHostname }),
            "proxy_not_trusted",
            String(remoteHostname),
        );
    }
});

Deno.test("proxy — a web page is refused, proxy or not", () => {
    const headers = { ...SERVE, "origin": "https://evil.example" };

    assertEquals(proxiedCode(headers), "origin_not_allowed");
});

Deno.test("proxy — the model list passes", () => {
    const routes = ["/v1/models", "/v1/models/saxby"];

    for (const path of routes) {
        assertEquals(
            proxiedCode(SERVE, { path, method: "GET" }),
            null,
            path,
        );
    }
});

Deno.test("proxy — everything but chat and models stays local", () => {
    const routes = [
        ["POST", "/saxby/v1/reservations"],
        ["GET", "/saxby/v1/reservations"],
        ["GET", "/saxby/v1/status"],
        ["POST", "/saxby/v1/explain"],
        ["POST", "/v1/embeddings"],
        ["GET", "/api/tags"],
        ["POST", "/api/generate"],
        ["POST", "/api/pull"],
        ["GET", "/v1/chat/completions"],
        ["POST", "/v1/models"],
        ["GET", "/v1/modelsx"],
    ];

    for (const [method, path] of routes) {
        assertEquals(
            proxiedCode(SERVE, { method, path }),
            "proxy_path_not_allowed",
            `${method} ${path}`,
        );
    }
});

Deno.test("proxy — naming a proxy changes nothing for local clients", () => {
    for (const headers of [OPEN_WEBUI, OPENCLAW, CURL]) {
        assertEquals(inspectProxied(headers), null);
    }

    assertEquals(
        proxiedCode({ host: "attacker.example" }),
        "host_not_allowed",
    );

    assertEquals(
        proxiedCode(CURL, { path: "/api/pull" }),
        "management_not_allowed",
    );
});
