import { assertEquals } from "@std/assert";
import {
    fetchInstanceStatus,
    fetchSaxbyStatus,
    isPortHeld,
    listConfigWarnings,
    probeHostFor,
    probeTokenFor,
} from "./probe.js";

Deno.test("probe — a wildcard bind is probed on loopback", () => {
    for (const host of ["0.0.0.0", "::", "[::]"]) {
        assertEquals(probeHostFor(host), "127.0.0.1", host);
    }
});

Deno.test("probe — any other bind is probed where it listens", () => {
    for (const host of ["127.0.0.1", "10.0.0.5", "::1", "localhost"]) {
        assertEquals(probeHostFor(host), host, host);
    }
});

//  Port 0 asks the OS for any free port, so the test never collides
//  with a running saxbyd.
Deno.test("probe — a port with a listener is held", () => {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const { port } = listener.addr;

    try {
        assertEquals(isPortHeld(port), true);
    } finally {
        listener.close();
    }
});

Deno.test("probe — a port freed again is not held", () => {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const { port } = listener.addr;

    listener.close();

    assertEquals(isPortHeld(port), false);
});

//  =====================================================================
//  The API token on a probe
//  =====================================================================
//  A stand-in saxbyd that records the Authorization header it is sent.
//  Port 0 again, so nothing collides with a running one.

function fakeDaemon(hostname) {
    const seen = [];

    const server = Deno.serve(
        { hostname, port: 0, onListen: () => {} },
        (request) => {
            seen.push(request.headers.get("authorization"));

            return Response.json({ instance: null, port: 1, pid: 1 });
        },
    );

    return { seen, port: server.addr.port, stop: () => server.shutdown() };
}

async function withConfigRoot(fn) {
    const root = await Deno.makeTempDir();
    const before = Deno.env.get("XDG_CONFIG_HOME");

    Deno.env.set("XDG_CONFIG_HOME", root);

    try {
        await Deno.mkdir(`${root}/saxby`);
        await Deno.writeTextFile(`${root}/saxby/api-token`, "the-token\n");
        await fn();
    } finally {
        if (before === undefined) {
            Deno.env.delete("XDG_CONFIG_HOME");
        } else {
            Deno.env.set("XDG_CONFIG_HOME", before);
        }

        await Deno.remove(root, { recursive: true });
    }
}

Deno.test("probe — a token is sent only when one is given", async () => {
    const daemon = fakeDaemon("127.0.0.1");

    try {
        await fetchSaxbyStatus(daemon.port);
        await fetchSaxbyStatus(daemon.port, "127.0.0.1", "the-token");

        assertEquals(daemon.seen, [null, "Bearer the-token"]);
    } finally {
        await daemon.stop();
    }
});

Deno.test("probe — a daemon on 127.0.0.1 is sent no token", async () => {
    const daemon = fakeDaemon("127.0.0.1");

    try {
        await withConfigRoot(async () => {
            for (const listen_host of ["127.0.0.1", "0.0.0.0"]) {
                const config = { listen_port: daemon.port, listen_host };
                const status = await fetchInstanceStatus(config, null);

                assertEquals(status.pid, 1, listen_host);
            }
        });

        assertEquals(daemon.seen, [null, null]);
    } finally {
        await daemon.stop();
    }
});

//  The test task may reach 127.0.0.1 only, so a daemon on another
//  address cannot be stood up here. What decides whether a token is
//  sent is probeTokenFor, tested on its own.
Deno.test("probe — a daemon asked anywhere else gets the token", async () => {
    await withConfigRoot(async () => {
        for (const host of ["10.0.0.5", "::1", "localhost", "127.0.0.2"]) {
            assertEquals(await probeTokenFor(host, null), "the-token", host);
        }

        for (const host of ["127.0.0.1", "0.0.0.0", "::", "[::]"]) {
            assertEquals(await probeTokenFor(host, null), null, host);
        }
    });
});

Deno.test("probe — a token that cannot be read is no token", async () => {
    const root = await Deno.makeTempDir();
    const before = Deno.env.get("XDG_CONFIG_HOME");

    Deno.env.set("XDG_CONFIG_HOME", root);

    try {
        assertEquals(await probeTokenFor("10.0.0.5", null), null);
        assertEquals(await probeTokenFor("10.0.0.5", "nosuch"), null);

        await Deno.mkdir(`${root}/saxby`);
        await Deno.writeTextFile(`${root}/saxby/api-token`, "two words\n");

        assertEquals(await probeTokenFor("10.0.0.5", null), null);
    } finally {
        if (before === undefined) {
            Deno.env.delete("XDG_CONFIG_HOME");
        } else {
            Deno.env.set("XDG_CONFIG_HOME", before);
        }

        await Deno.remove(root, { recursive: true });
    }
});

//  =====================================================================
//  What a status answer says about the config
//  =====================================================================

const STATUS = { instance: null, port: 11435, pid: 1, version: "0.0.0" };
const LOADED_AT = "2026-11-09T12:00:00.000Z";

Deno.test("config warnings — none when the file is what runs", () => {
    const config = { loaded_at: LOADED_AT, declined: null, watch_error: null };

    assertEquals(listConfigWarnings({ ...STATUS, config }), []);
});

Deno.test("config warnings — none from a saxbyd too old to say", () => {
    assertEquals(listConfigWarnings(STATUS), []);
    assertEquals(listConfigWarnings(null), []);
});

Deno.test("config warnings — a declined edit carries its reason", () => {
    const config = {
        loaded_at: LOADED_AT,
        declined: { at: "2026-11-09T12:05:00.000Z", reason: "- oops" },
        watch_error: null,
    };

    assertEquals(listConfigWarnings({ ...STATUS, config }), [
        "The config on disk is NOT applied; saxbyd still runs the one " +
        `loaded ${LOADED_AT}.\n- oops`,
    ]);
});

Deno.test("config warnings — a dead watch is named", () => {
    const config = {
        loaded_at: LOADED_AT,
        declined: null,
        watch_error: "too many open files",
    };

    assertEquals(listConfigWarnings({ ...STATUS, config }), [
        "Config edits are NOT being watched (too many open files). " +
        "Restart to apply an edit.",
    ]);
});
