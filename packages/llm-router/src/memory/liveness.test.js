import { assertEquals } from "@std/assert";
import { isPid, isProcessAlive } from "./liveness.js";

//  The real `kill -0` cases run only where the test run may start
//  /bin/kill (deno task test grants it); otherwise they are skipped,
//  not failed.
const CAN_RUN_KILL = Deno.build.os === "darwin" &&
    Deno.permissions.querySync({ name: "run", command: "/bin/kill" })
            .state === "granted";

//  macOS pids stop below 99,999, so this one cannot be running.
const NEVER_A_PID = 99_999_999;

Deno.test("liveness — only positive whole numbers are pids", () => {
    assertEquals(isPid(4242), true);
    assertEquals(isPid(0), false);
    assertEquals(isPid(-1), false);
    assertEquals(isPid(1.5), false);
    assertEquals(isPid("4242"), false);
});

Deno.test("liveness — a bad pid is dead without running kill", async () => {
    assertEquals(await isProcessAlive(-1), false);
    assertEquals(await isProcessAlive("1; rm -rf /"), false);
});

Deno.test({
    name: "liveness — this test process is alive",
    ignore: !CAN_RUN_KILL,
    fn: async () => {
        assertEquals(await isProcessAlive(Deno.pid), true);
    },
});

Deno.test({
    name: "liveness — a pid nothing holds is dead",
    ignore: !CAN_RUN_KILL,
    fn: async () => {
        assertEquals(await isProcessAlive(NEVER_A_PID), false);
    },
});

Deno.test({
    name: "liveness — another user's process counts as not alive",
    ignore: !CAN_RUN_KILL,
    fn: async () => {
        //  pid 1 is launchd, owned by root.
        assertEquals(await isProcessAlive(1), false);
    },
});
