import { assertEquals, assertThrows } from "@std/assert";
import { parseCommand, readInstanceFlag } from "./args.js";

Deno.test("args — no arguments runs the daemon", () => {
    assertEquals(parseCommand([]), "run");
});

Deno.test("args — every known flag runs the daemon", () => {
    const cases = [
        ["--trace"],
        ["--verbose"],
        ["-v"],
        ["--instance", "dev"],
        ["-i", "dev"],
        ["--instance=dev"],
        ["-i", "dev", "--trace"],
    ];

    for (const args of cases) {
        assertEquals(parseCommand(args), "run", args.join(" "));
    }
});

Deno.test("args — --version and -V print the version", () => {
    assertEquals(parseCommand(["--version"]), "version");
    assertEquals(parseCommand(["-V"]), "version");
    assertEquals(parseCommand(["-i", "dev", "--version"]), "version");
});

Deno.test("args — --help and -h print usage", () => {
    assertEquals(parseCommand(["--help"]), "help");
    assertEquals(parseCommand(["-h"]), "help");
});

Deno.test("args — an unknown flag is refused, not ignored", () => {
    for (const flag of ["--instnace", "--port", "-x", "--trace=1"]) {
        assertThrows(
            () => parseCommand([flag, "dev"]),
            Error,
            `Unknown option '${flag}'`,
        );
    }
});

Deno.test("args — a stray word is refused", () => {
    assertThrows(
        () => parseCommand(["dev"]),
        Error,
        "Unexpected argument 'dev'",
    );
});

Deno.test("args — an instance flag without a name is refused", () => {
    assertThrows(() => parseCommand(["-i"]), Error, "-i needs");
    assertThrows(
        () => parseCommand(["--instance", "--trace"]),
        Error,
        "--instance needs",
    );
});

Deno.test("args — the instance name never counts as a stray word", () => {
    assertEquals(parseCommand(["-i", "version"]), "run");
});

Deno.test("args — readInstanceFlag reads all three spellings", () => {
    assertEquals(readInstanceFlag(["--instance", "dev"]), "dev");
    assertEquals(readInstanceFlag(["-i", "dev"]), "dev");
    assertEquals(readInstanceFlag(["--instance=dev"]), "dev");
    assertEquals(readInstanceFlag(["--trace"]), undefined);
});
