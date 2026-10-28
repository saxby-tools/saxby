import { assertEquals } from "@std/assert";
import { buildAllowedHosts, inspectRequest } from "./guard.js";

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

function inspect(headers, path = "/v1/chat/completions", allowedHosts) {
    return inspectRequest({
        headers: new Headers(headers),
        path,
        allowedHosts,
    });
}

function codeFor(headers, path, allowedHosts) {
    return inspect(headers, path, allowedHosts)?.code ?? null;
}

const CHAT = "/v1/chat/completions";

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

Deno.test("guard — the Host refusal says where to allow a name", () => {
    const verdict = inspect({ host: "saxby:11435" });

    assertEquals(verdict.code, "host_not_allowed");
    assertEquals(verdict.message.includes("allowed_hosts"), true);
});

//  A Compose service name, as Open WebUI sends it from the next
//  container over, and Podman's name for the host.
const COMPOSE_HOSTS = buildAllowedHosts([
    "saxby",
    "Host.Containers.Internal:9999",
]);

Deno.test("guard — allowed_hosts names pass, any case, any port", () => {
    const hosts = [
        "saxby",
        "saxby:11435",
        "SAXBY:11435",
        "host.containers.internal:11435",
    ];

    for (const host of hosts) {
        assertEquals(inspect({ host }, CHAT, COMPOSE_HOSTS), null, host);
    }
});

Deno.test("guard — allowed_hosts adds to the local names", () => {
    for (const host of ["127.0.0.1:11435", "host.docker.internal:11435"]) {
        assertEquals(inspect({ host }, CHAT, COMPOSE_HOSTS), null, host);
    }
});

Deno.test("guard — allowed_hosts leaves foreign names refused", () => {
    for (const host of ["attacker.example", "saxby.example"]) {
        assertEquals(
            codeFor({ host }, CHAT, COMPOSE_HOSTS),
            "host_not_allowed",
            host,
        );
    }
});

Deno.test("guard — an empty allowed_hosts is the local names alone", () => {
    const local = buildAllowedHosts();

    assertEquals(buildAllowedHosts([]), local);
    assertEquals(codeFor({ host: "saxby" }, CHAT, local), "host_not_allowed");
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
