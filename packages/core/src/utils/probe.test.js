import { assertEquals } from "@std/assert";
import { isPortHeld, probeHostFor } from "./probe.js";

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
