import { assertEquals } from "@std/assert";
import { isPortHeld } from "./probe.js";

//  Port 0 asks the OS for any free port, so the test never collides
//  with a running shuntd.
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
