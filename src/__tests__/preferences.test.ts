// src/__tests__/preferences.test.ts
//
// Falsifies the preferences loader and the input-handler gate.
//
// The loader resolves its path through the package's getAgentDir(), which reads
// PI_CODING_AGENT_DIR fresh on every call (no caching), so each test points it
// at its own tmpdir. That keeps the suite hermetic without stubbing the module.
//
// The gate tests drive registerInputHandlers directly with an injected
// getStyle, so they need no filesystem at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    DEFAULT_BASH_INPUT_STYLE,
    getBashInputStyle,
    loadPreferences,
    preferencesPath,
    setBashInputStyle,
    takePreferencesWarning,
    writePreferences,
} from "../preferences.ts";
import { registerInputHandlers } from "../input.ts";
import { BackgroundRegistry } from "../state.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

/** Point getAgentDir() at a fresh tmpdir; returns the preferences.json path. */
function useTempAgentDir(): { path: string; dir: string; restore: () => void } {
    const previous = process.env[ENV_AGENT_DIR];
    const dir = mkdtempSync(join(tmpdir(), "pi-bg-prefs-"));
    process.env[ENV_AGENT_DIR] = dir;
    const path = preferencesPath();
    return {
        path,
        dir,
        restore: () => {
            if (previous === undefined) delete process.env[ENV_AGENT_DIR];
            else process.env[ENV_AGENT_DIR] = previous;
            rmSync(dir, { recursive: true, force: true });
            // Leave the module in its default state for the next test.
            setBashInputStyle(DEFAULT_BASH_INPUT_STYLE);
            takePreferencesWarning();
        },
    };
}

function writePrefsFile(path: string, contents: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents, "utf-8");
}

// ── Loader ────────────────────────────────────────────────────────

test("missing file resolves to the default and creates nothing", async () => {
    const t = useTempAgentDir();
    try {
        assert.equal(await loadPreferences(), "queue");
        assert.equal(getBashInputStyle(), "queue");
        assert.throws(() => readFileSync(t.path, "utf-8"));
        // A first run is not a problem worth warning about.
        assert.equal(takePreferencesWarning(), undefined);
    } finally {
        t.restore();
    }
});

test("malformed JSON resolves to the default, warns, and does not overwrite the file", async () => {
    const t = useTempAgentDir();
    try {
        writePrefsFile(t.path, "{ not json");
        assert.equal(await loadPreferences(), "queue");
        // The user's typo survives — a silent rewrite would destroy their edit.
        assert.equal(readFileSync(t.path, "utf-8"), "{ not json");
        assert.match(String(takePreferencesWarning()), /not valid JSON/);
    } finally {
        t.restore();
    }
});

test("a non-object root resolves to the default and warns", async () => {
    const t = useTempAgentDir();
    try {
        writePrefsFile(t.path, "[1, 2, 3]");
        assert.equal(await loadPreferences(), "queue");
        assert.match(String(takePreferencesWarning()), /expected a JSON object/);
    } finally {
        t.restore();
    }
});

test("an unknown bashInputStyle value resolves to the default and warns", async () => {
    const t = useTempAgentDir();
    try {
        writePrefsFile(t.path, JSON.stringify({ schemaVersion: 1, bashInputStyle: "foo" }));
        assert.equal(await loadPreferences(), "queue");
        assert.match(String(takePreferencesWarning()), /expected "queue" or "interrupt"/);
    } finally {
        t.restore();
    }
});

test("a newer schemaVersion resolves to the default and warns", async () => {
    const t = useTempAgentDir();
    try {
        writePrefsFile(
            t.path,
            JSON.stringify({ schemaVersion: 99, bashInputStyle: "interrupt" })
        );
        assert.equal(await loadPreferences(), "queue");
        assert.match(String(takePreferencesWarning()), /newer than this extension/);
    } finally {
        t.restore();
    }
});

test("a missing schemaVersion still reads the style — the field is optional for v1 reads", async () => {
    const t = useTempAgentDir();
    try {
        writePrefsFile(t.path, JSON.stringify({ bashInputStyle: "interrupt" }));
        assert.equal(await loadPreferences(), "interrupt");
        assert.equal(takePreferencesWarning(), undefined);
    } finally {
        t.restore();
    }
});

test('a valid "interrupt" file is honoured', async () => {
    const t = useTempAgentDir();
    try {
        writePrefsFile(
            t.path,
            JSON.stringify({ schemaVersion: 1, bashInputStyle: "interrupt" })
        );
        assert.equal(await loadPreferences(), "interrupt");
        assert.equal(getBashInputStyle(), "interrupt");
    } finally {
        t.restore();
    }
});

// ── Writer ────────────────────────────────────────────────────────

test("writePreferences creates the directory and a parseable file", async () => {
    const t = useTempAgentDir();
    try {
        await writePreferences("interrupt");
        const parsed = JSON.parse(readFileSync(t.path, "utf-8")) as Record<string, unknown>;
        assert.equal(parsed.bashInputStyle, "interrupt");
        assert.equal(parsed.schemaVersion, 1);
        // Round-trips through the loader.
        assert.equal(await loadPreferences(), "interrupt");
    } finally {
        t.restore();
    }
});

test("writePreferences leaves no temp file behind (it renames, it does not copy)", async () => {
    const t = useTempAgentDir();
    try {
        await writePreferences("interrupt");
        const { readdirSync } = await import("node:fs");
        const entries = readdirSync(join(t.dir, "pi-bg-tasks"));
        assert.deepEqual(entries, ["preferences.json"]);
    } finally {
        t.restore();
    }
});

test("writePreferences preserves unknown keys", async () => {
    const t = useTempAgentDir();
    try {
        writePrefsFile(
            t.path,
            JSON.stringify({ schemaVersion: 1, bashInputStyle: "queue", futureKey: 7 })
        );
        await writePreferences("interrupt");
        const parsed = JSON.parse(readFileSync(t.path, "utf-8")) as Record<string, unknown>;
        assert.equal(parsed.bashInputStyle, "interrupt");
        assert.equal(parsed.futureKey, 7);
    } finally {
        t.restore();
    }
});

// ── The gate ──────────────────────────────────────────────────────

interface GateProbe {
    result: { action: string } | undefined;
    abortCalls: number;
    sentMessages: string[];
    pauseRequests?: number;
}

/**
 * Drive registerInputHandlers with an active foreground slot and a chosen
 * style, and report what the handler did.
 */
async function runGate(style: "queue" | "interrupt"): Promise<GateProbe> {
    let pauseRequests = 0;

    const reg = new BackgroundRegistry();
    const toolCallId = "call-1";
    reg.activeToolCallId = toolCallId;
    reg.foreground.set(toolCallId, {
        requestPause: () => {
            pauseRequests += 1;
        },
    });

    const probe: GateProbe = { result: undefined, abortCalls: 0, sentMessages: [] };

    let handler:
        | ((event: unknown, ctx: unknown) => Promise<{ action: string }>)
        | undefined;

    const pi = {
        on(name: string, fn: (event: unknown, ctx: unknown) => Promise<{ action: string }>) {
            if (name === "input") handler = fn;
        },
        sendUserMessage(text: string) {
            probe.sentMessages.push(text);
        },
    } as unknown as ExtensionAPI;

    registerInputHandlers(pi, reg, () => style);
    assert.ok(handler, "an input handler should have been registered");

    const ctx = {
        ui: {
            notify() {},
            setWidget() {},
            setStatus() {},
            theme: { fg: (_c: string, s: string) => s },
            async select() {
                return undefined;
            },
            async editor() {
                return undefined;
            },
        },
        abort() {
            probe.abortCalls += 1;
        },
    };

    probe.result = await handler({ text: "hello", source: "user" }, ctx);
    probe.pauseRequests = pauseRequests;
    return probe;
}

test('"queue" falls through without touching abort or the message queue', async () => {
    const probe = await runGate("queue");
    assert.deepEqual(probe.result, { action: "continue" });
    assert.equal(probe.abortCalls, 0);
    assert.deepEqual(probe.sentMessages, []);
});

test('"interrupt" aborts the turn and resubmits the message', async () => {
    const probe = await runGate("interrupt");
    assert.deepEqual(probe.result, { action: "handled" });
    assert.equal(probe.abortCalls, 1);
    assert.deepEqual(probe.sentMessages, ["hello"]);
});

test("extension-sourced input is never intercepted, even under interrupt", async () => {
    const reg = new BackgroundRegistry();
    reg.activeToolCallId = "call-1";
    reg.foreground.set("call-1", { requestPause: () => {} });

    let handler:
        | ((event: unknown, ctx: unknown) => Promise<{ action: string }>)
        | undefined;
    let sent = 0;
    const pi = {
        on(name: string, fn: (event: unknown, ctx: unknown) => Promise<{ action: string }>) {
            if (name === "input") handler = fn;
        },
        sendUserMessage() {
            sent += 1;
        },
    } as unknown as ExtensionAPI;

    registerInputHandlers(pi, reg, () => "interrupt");
    assert.ok(handler);

    const result = await handler({ text: "hi", source: "extension" }, { abort() {} });
    assert.deepEqual(result, { action: "continue" });
    assert.equal(sent, 0);
});

test("with no active foreground slot the handler always falls through", async () => {
    const reg = new BackgroundRegistry();
    let handler:
        | ((event: unknown, ctx: unknown) => Promise<{ action: string }>)
        | undefined;
    const pi = {
        on(name: string, fn: (event: unknown, ctx: unknown) => Promise<{ action: string }>) {
            if (name === "input") handler = fn;
        },
        sendUserMessage() {},
    } as unknown as ExtensionAPI;

    registerInputHandlers(pi, reg, () => "interrupt");
    assert.ok(handler);

    const result = await handler({ text: "hi", source: "user" }, { abort() {} });
    assert.deepEqual(result, { action: "continue" });
});
