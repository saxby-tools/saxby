import { assertEquals } from "@std/assert";
import { isInContainer, isLoopbackHost } from "./listen.js";

Deno.test("listen — loopback names and the whole 127/8 block", () => {
    const hosts = ["127.0.0.1", "127.0.0.2", " LocalHost ", "::1", "[::1]"];

    for (const host of hosts) {
        assertEquals(isLoopbackHost(host), true, host);
    }
});

Deno.test("listen — anything else is not loopback", () => {
    const hosts = ["0.0.0.0", "::", "10.0.0.5", "saxby", "12.7.0.1"];

    for (const host of hosts) {
        assertEquals(isLoopbackHost(host), false, host);
    }
});

Deno.test("listen — a name is not loopback", () => {
    for (const host of ["example.com", "host.docker.internal"]) {
        assertEquals(isLoopbackHost(host), false, host);
    }
});

Deno.test("listen — a Docker or Podman marker is a container", async () => {
    const docker = (path) => Promise.resolve(path === "/.dockerenv");
    const podman = (path) => Promise.resolve(path === "/run/.containerenv");

    assertEquals(await isInContainer(docker), true);
    assertEquals(await isInContainer(podman), true);
});

Deno.test("listen — no marker means no container", async () => {
    assertEquals(await isInContainer(() => Promise.resolve(false)), false);
});
