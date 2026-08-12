// src/__tests__/monitor-trigger-turn.test.ts
//
// Falsifies the opt-in `triggerTurn` flag on the `monitor` tool: when set,
// each emitted line is delivered via DELIVER_STEER (triggerTurn: true) so it
// wakes the agent; when unset (default), via DELIVER_FOLLOWUP (triggerTurn:
// false). Default behavior must be byte-identical to before the change.
//
// Note on teardown: the fake source's `exit` promise is intentionally never
// resolved/rejected during a test. Resolving it would fire the session's
// onExit → finishMonitor → enqueueMonitorEnd coalescer (a timer that flushes
// after the test ends, which node:test flags as stray async activity);
// rejecting it surfaces as an unhandledRejection. The follower's poll timer
// is unref()'d, so it never keeps the process alive, and once the log file is
// removed its statSync throws harmlessly and readNew() returns []. This is
// the cleanest self-contained shape for a unit test of the delivery constant.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { startMonitorSession } from "../monitor-session.ts";
import { BackgroundRegistry } from "../state.ts";
import { DELIVER_FOLLOWUP, DELIVER_STEER, EVENT } from "../types.ts";
import { createRunningJob } from "../registry.ts";
import type { MonitorSource } from "../monitor-source.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const fakeCtx = {
    ui: {
        notify() {},
        setWidget() {},
        setStatus() {},
        theme: { fg: (_c: string, t: string) => t },
        async select() {
            return undefined;
        },
        async editor() {
            return undefined;
        },
    },
} as never;

interface Captured {
    msg: unknown;
    deliver: unknown;
}

function makeFakePi(): { pi: ExtensionAPI; calls: Captured[] } {
    const calls: Captured[] = [];
    const pi = {
        sendMessage(msg: unknown, deliver: unknown) {
            calls.push({ msg, deliver });
        },
        appendEntry() {},
        on() {},
        registerTool() {},
    } as unknown as ExtensionAPI;
    return { pi, calls };
}

function makeFakeSource(logPath: string): MonitorSource {
    return {
        logPath,
        pid: 0,
        label: "fake",
        exit: new Promise<number | null>(() => {}),
        stop() {},
    };
}

function makeJob(logPath: string) {
    return createRunningJob({
        id: "job-test-1",
        command: "fake",
        pid: 0,
        logPath,
        toolCallId: "tc-test",
        kind: "monitor" as const,
    });
}

function appendLine(logPath: string, line: string): void {
    writeFileSync(logPath, line + "\n", { flag: "a" });
}

async function waitForCall(calls: Captured[], timeoutMs = 1500): Promise<Captured[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (calls.length > 0) return calls;
        await new Promise((r) => setTimeout(r, 50));
    }
    return calls;
}

function freshLog(): string {
    const dir = mkdtempSync(join(tmpdir(), "monitor-trigger-turn-"));
    const logPath = join(dir, "job.log");
    writeFileSync(logPath, "");
    return logPath;
}

function cleanup(logPath: string): void {
    rmSync(dirname(logPath), { recursive: true, force: true });
}

test("triggerTurn=true delivers lines via DELIVER_STEER (wakes the agent)", async () => {
    const logPath = freshLog();
    const { pi, calls } = makeFakePi();
    const reg = new BackgroundRegistry();
    const job = makeJob(logPath);
    reg.jobs.set(job.id, job);
    const source = makeFakeSource(logPath);

    startMonitorSession({
        pi,
        reg,
        ctx: fakeCtx,
        job,
        source,
        description: "tick",
        persistent: false,
        timeoutMs: 60_000,
        triggerTurn: true,
    });

    appendLine(logPath, "hello");
    await waitForCall(calls);

    assert.ok(calls.length > 0, "expected a sendMessage call after appending a line");
    const { msg, deliver } = calls[0];
    assert.deepEqual(
        deliver,
        DELIVER_STEER,
        "triggerTurn=true must deliver via DELIVER_STEER (triggerTurn: true)"
    );
    assert.equal(
        (msg as { customType?: string }).customType,
        EVENT.monitorEvent,
        "must still emit a monitorEvent"
    );

    cleanup(logPath);
});

test("triggerTurn unset (default) delivers lines via DELIVER_FOLLOWUP (passive)", async () => {
    const logPath = freshLog();
    const { pi, calls } = makeFakePi();
    const reg = new BackgroundRegistry();
    const job = makeJob(logPath);
    reg.jobs.set(job.id, job);
    const source = makeFakeSource(logPath);

    startMonitorSession({
        pi,
        reg,
        ctx: fakeCtx,
        job,
        source,
        description: "tick",
        persistent: false,
        timeoutMs: 60_000,
    });

    appendLine(logPath, "hello");
    await waitForCall(calls);

    assert.ok(calls.length > 0, "expected a sendMessage call after appending a line");
    assert.deepEqual(
        calls[0].deliver,
        DELIVER_FOLLOWUP,
        "triggerTurn unset must deliver via DELIVER_FOLLOWUP (triggerTurn: false) — default unchanged"
    );

    cleanup(logPath);
});

test("triggerTurn=false explicitly delivers lines via DELIVER_FOLLOWUP (passive)", async () => {
    const logPath = freshLog();
    const { pi, calls } = makeFakePi();
    const reg = new BackgroundRegistry();
    const job = makeJob(logPath);
    reg.jobs.set(job.id, job);
    const source = makeFakeSource(logPath);

    startMonitorSession({
        pi,
        reg,
        ctx: fakeCtx,
        job,
        source,
        description: "tick",
        persistent: false,
        timeoutMs: 60_000,
        triggerTurn: false,
    });

    appendLine(logPath, "hello");
    await waitForCall(calls);

    assert.ok(calls.length > 0, "expected a sendMessage call");
    assert.deepEqual(
        calls[0].deliver,
        DELIVER_FOLLOWUP,
        "triggerTurn=false must deliver via DELIVER_FOLLOWUP"
    );

    cleanup(logPath);
});