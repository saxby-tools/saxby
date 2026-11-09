import { assert, assertEquals, assertRejects } from "@std/assert";
import {
    API_TOKEN_FILE,
    apiTokenPath,
    generateApiToken,
    isWeakApiToken,
    readApiToken,
    readOrCreateApiToken,
    sameApiToken,
    writeApiToken,
} from "./token.js";

function modeOf(path) {
    return Deno.statSync(path).mode & 0o777;
}

async function withDir(fn) {
    const dir = await Deno.makeTempDir();

    try {
        await fn(dir);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
}

Deno.test("token — a generated token is 64 hex characters", () => {
    const token = generateApiToken();

    assert(/^[0-9a-f]{64}$/.test(token));
    assert(token !== generateApiToken());
    assertEquals(isWeakApiToken(token), false);
});

Deno.test("token — a short token is weak, a long one is not", () => {
    assertEquals(isWeakApiToken("saxby"), true);
    assertEquals(isWeakApiToken("x".repeat(31)), true);
    assertEquals(isWeakApiToken("x".repeat(32)), false);
});

Deno.test("token — no file reads as no token", async () => {
    await withDir(async (dir) => {
        assertEquals(await readApiToken(dir), null);
    });
});

Deno.test("token — the first read writes one, owner-only", async () => {
    await withDir(async (dir) => {
        const first = await readOrCreateApiToken(dir);

        assertEquals(first.created, true);
        assertEquals(first.path, apiTokenPath(dir));
        assertEquals(first.path.endsWith(API_TOKEN_FILE), true);
        assertEquals(modeOf(first.path), 0o600);

        const second = await readOrCreateApiToken(dir);

        assertEquals(second.created, false);
        assertEquals(second.token, first.token);
    });
});

Deno.test("token — a missing instance folder is never invented", async () => {
    await withDir(async (dir) => {
        const missing = `${dir}/instances/nosuch`;

        await assertRejects(
            () => readOrCreateApiToken(missing),
            Deno.errors.NotFound,
        );

        await assertRejects(
            () => writeApiToken(missing, "new-token"),
            Deno.errors.NotFound,
        );

        await assertRejects(() => Deno.stat(missing), Deno.errors.NotFound);
    });
});

Deno.test("token — writers racing at first boot agree on one", async () => {
    await withDir(async (dir) => {
        const found = await Promise.all(
            Array.from({ length: 8 }, () => readOrCreateApiToken(dir)),
        );

        const tokens = new Set(found.map((each) => each.token));
        const creators = found.filter((each) => each.created);

        assertEquals(tokens.size, 1);
        assertEquals(creators.length, 1);
        assertEquals(await readApiToken(dir), found[0].token);
    });
});

Deno.test("token — no staging file is left behind", async () => {
    await withDir(async (dir) => {
        await readOrCreateApiToken(dir);
        await readOrCreateApiToken(dir);
        await writeApiToken(dir, "new-token");

        const names = [...Deno.readDirSync(dir)].map((entry) => entry.name);

        assertEquals(names, [API_TOKEN_FILE]);
    });
});

Deno.test("token — the operator's own token is kept as written", async () => {
    await withDir(async (dir) => {
        await Deno.writeTextFile(apiTokenPath(dir), "  my-own-token\n\n");

        const found = await readOrCreateApiToken(dir);

        assertEquals(found.token, "my-own-token");
        assertEquals(found.created, false);
    });
});

Deno.test("token — a file left readable by others is tightened", async () => {
    await withDir(async (dir) => {
        const path = apiTokenPath(dir);

        await Deno.writeTextFile(path, "my-own-token\n", { mode: 0o644 });
        await Deno.chmod(path, 0o644);
        await readOrCreateApiToken(dir);

        assertEquals(modeOf(path), 0o600);
    });
});

Deno.test("token — a replaced token never keeps a wider mode", async () => {
    await withDir(async (dir) => {
        const path = apiTokenPath(dir);

        await Deno.writeTextFile(path, "old-token\n", { mode: 0o644 });
        await Deno.chmod(path, 0o644);
        await writeApiToken(dir, "new-token");

        assertEquals(modeOf(path), 0o600);
        assertEquals(await readApiToken(dir), "new-token");
    });
});

Deno.test("token — an empty or multi-line file is refused", async () => {
    for (const content of ["", "\n", "two words", "line one\nline two"]) {
        await withDir(async (dir) => {
            await Deno.writeTextFile(apiTokenPath(dir), content);

            const error = await assertRejects(() => readApiToken(dir));

            assert(error.message.includes("saxby token rotate"), content);
        });
    }
});

Deno.test("token — an unusable token is never written", async () => {
    await withDir(async (dir) => {
        await assertRejects(() => writeApiToken(dir, "has space"));
        await assertRejects(() => writeApiToken(dir, ""));

        assertEquals(await readApiToken(dir), null);
    });
});

Deno.test("token — only the exact token matches", () => {
    const token = generateApiToken();

    assertEquals(sameApiToken(token, token), true);
    assertEquals(sameApiToken(`${token}x`, token), false);
    assertEquals(sameApiToken(token.slice(1), token), false);
    assertEquals(sameApiToken(token.toUpperCase(), token), false);
    assertEquals(sameApiToken("", token), false);
    assertEquals(sameApiToken("", ""), true);
});
