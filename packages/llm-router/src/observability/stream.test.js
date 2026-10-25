import { assertEquals } from "@std/assert";
import { observeResponse } from "./stream.js";

const encoder = new TextEncoder();

const USAGE_FRAME = 'data: {"usage":{"prompt_tokens":12,' +
    '"completion_tokens":3}}\n\n';

function sseBody(frames) {
    return new ReadableStream({
        start(controller) {
            for (const frame of frames) {
                controller.enqueue(encoder.encode(frame));
            }

            controller.close();
        },
    });
}

//  Records which handlers fired, in order.
function recorder() {
    const calls = [];

    return {
        calls,
        handlers: {
            onFirstByte: () => calls.push("firstByte"),
            onUsage: (usage) => calls.push(`usage:${usage.promptTokens}`),
            onEnd: () => calls.push("end"),
            onCancel: () => calls.push("cancel"),
        },
    };
}

async function drain(stream) {
    const reader = stream.getReader();

    while (!(await reader.read()).done) {
        //  Read to the end.
    }
}

Deno.test("stream — a finished stream ends, never cancels", async () => {
    const { calls, handlers } = recorder();
    const body = sseBody(['data: {"choices":[]}\n\n', USAGE_FRAME]);

    await drain(observeResponse(body, handlers));

    assertEquals(calls, ["firstByte", "usage:12", "end"]);
});

Deno.test("stream — a client leaving mid-stream cancels", async () => {
    const { calls, handlers } = recorder();

    //  An upstream that never ends, like a model still generating.
    const body = new ReadableStream({
        pull(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[]}\n\n'));
        },
    });

    const reader = observeResponse(body, handlers).getReader();

    await reader.read();
    await reader.cancel("client disconnected");

    assertEquals(calls.includes("cancel"), true);
    assertEquals(calls.includes("end"), false);
});

Deno.test("stream — an upstream failing mid-stream cancels", async () => {
    const { calls, handlers } = recorder();

    let sent = false;

    const body = new ReadableStream({
        pull(controller) {
            if (!sent) {
                sent = true;
                controller.enqueue(encoder.encode('data: {"choices":[]}\n'));
                return;
            }

            controller.error(new Error("upstream reset"));
        },
    });

    const reader = observeResponse(body, handlers).getReader();

    await reader.read();
    await reader.read().catch(() => {});

    assertEquals(calls.includes("cancel"), true);
    assertEquals(calls.includes("end"), false);
});
