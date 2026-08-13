// src/preferences.ts
//
// Per-user preferences for this extension, in a file the extension owns
// exclusively:
//
//     <agentDir>/pi-bg-tasks/preferences.json
//     (by default ~/.pi/agent/pi-bg-tasks/preferences.json)
//
// The agent directory comes from the exported getAgentDir() helper rather than
// a hardcoded ~/.pi/agent, so PI_CODING_AGENT_DIR, rebranded distributions, and
// Nix/Guix-style install roots all resolve correctly.
//
// The file lives in an extension-private subdirectory rather than at the root
// of the agent dir on purpose: a shared <agentDir>/preferences.json would imply
// a cross-extension standard that pi core does not provide, and would oblige
// every writer to preserve every other extension's namespace. Here this
// extension is the sole reader and writer, so atomic replacement and schema
// migration stay local and simple.
//
// v1 is global only. Project-local overrides are deliberately deferred: they
// would drag in trust gating (project resources load only for trusted
// projects), precedence merging, and a "which scope does /bg-prefs write?"
// question that a single input-style toggle does not need. Input style is a
// user-level habit, not repo policy.
//
// There is no filesystem watcher. fs.watch is platform-flaky (APFS rename
// events, editors that atomic-save as rename-then-delete) and would add
// teardown obligations for no real gain on a one-key preference. Hand-edits are
// picked up by `/bg-prefs` → "Reload from disk", or by `/reload`. This is
// stated so a future maintainer does not assume a watcher went missing.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * What happens to a running foreground bash command when the user types.
 *
 * - `"queue"`   — pi's native steering: the message is queued and delivered at
 *                 the next turn boundary; the command is NOT aborted. Default.
 * - `"interrupt"` — the upstream "cooperative steering" path: the foreground
 *                 command is moved to the background, the current turn is
 *                 aborted, and the message is re-injected as a fresh turn.
 *
 * Naming note: an earlier draft of this design called these `"pi"` and
 * `"claude"`. That was dropped because the `"claude"` label is factually
 * wrong — Claude Code queues typed input and leaves the foreground command
 * running (measured on CC 2.1.231), so it is `"queue"` that matches Claude
 * Code, not `"interrupt"`. Naming the modes after what they *do* avoids
 * baking a mistaken vendor attribution into a config file that users will be
 * reading for years.
 */
export type BashInputStyle = "queue" | "interrupt";

export const DEFAULT_BASH_INPUT_STYLE: BashInputStyle = "queue";

/** Current schema version of preferences.json. */
export const PREFERENCES_SCHEMA_VERSION = 1;

const PREFS_DIR_NAME = "pi-bg-tasks";
const PREFS_FILE_NAME = "preferences.json";

function isBashInputStyle(value: unknown): value is BashInputStyle {
    return value === "queue" || value === "interrupt";
}

/** Absolute path to preferences.json. Resolved lazily so tests can override the agent dir. */
export function preferencesPath(): string {
    return join(getAgentDir(), PREFS_DIR_NAME, PREFS_FILE_NAME);
}

// ── In-memory state ───────────────────────────────────────────────
//
// The `input` handler is hot: it runs on every keystroke-submitted message.
// It reads this value, never the disk.

let current: BashInputStyle = DEFAULT_BASH_INPUT_STYLE;

/** Set by loadPreferences when it had to fall back, flushed once by session_start. */
let pendingWarning: string | undefined;

export function getBashInputStyle(): BashInputStyle {
    return current;
}

/** Update the in-memory value (called after a successful write, and by tests). */
export function setBashInputStyle(style: BashInputStyle): void {
    current = style;
}

/**
 * Take the one-shot warning recorded by loadPreferences, if any.
 *
 * loadPreferences runs in the extension factory, before any UI exists, so it
 * cannot notify directly. session_start drains this and shows it at most once
 * per session. In non-interactive modes there is no notify surface and the
 * warning is simply dropped — the fail-safe default still applies.
 */
export function takePreferencesWarning(): string | undefined {
    const w = pendingWarning;
    pendingWarning = undefined;
    return w;
}

/**
 * Read and validate preferences.json into memory.
 *
 * Fails safe to the default on every error path — missing file, unreadable
 * file, invalid JSON, non-object root, unknown `bashInputStyle`, or a
 * `schemaVersion` newer than this build understands. It NEVER rewrites a
 * malformed file: silently overwriting the user's typo would destroy their
 * edit with no signal. They fix it; `/bg-prefs` → Reload re-reads.
 *
 * Re-callable: `/bg-prefs` → Reload and pi's `/reload` both call this.
 */
export async function loadPreferences(): Promise<BashInputStyle> {
    pendingWarning = undefined;

    let raw: string;
    try {
        raw = await readFile(preferencesPath(), "utf-8");
    } catch {
        // Missing or unreadable is the normal first-run case, not a problem.
        current = DEFAULT_BASH_INPUT_STYLE;
        return current;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        pendingWarning = `Ignoring ${preferencesPath()}: not valid JSON. Using bash input style "${DEFAULT_BASH_INPUT_STYLE}".`;
        current = DEFAULT_BASH_INPUT_STYLE;
        return current;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        pendingWarning = `Ignoring ${preferencesPath()}: expected a JSON object. Using bash input style "${DEFAULT_BASH_INPUT_STYLE}".`;
        current = DEFAULT_BASH_INPUT_STYLE;
        return current;
    }

    const obj = parsed as Record<string, unknown>;

    // A *missing* schemaVersion is fine for v1 reads — the field is an
    // evolution safeguard, not a required key. A version we don't know is not.
    if (obj.schemaVersion !== undefined) {
        if (
            typeof obj.schemaVersion !== "number" ||
            obj.schemaVersion > PREFERENCES_SCHEMA_VERSION
        ) {
            pendingWarning = `Ignoring ${preferencesPath()}: schemaVersion ${String(obj.schemaVersion)} is newer than this extension understands. Using bash input style "${DEFAULT_BASH_INPUT_STYLE}".`;
            current = DEFAULT_BASH_INPUT_STYLE;
            return current;
        }
    }

    if (obj.bashInputStyle === undefined) {
        current = DEFAULT_BASH_INPUT_STYLE;
        return current;
    }

    if (!isBashInputStyle(obj.bashInputStyle)) {
        pendingWarning = `Ignoring bashInputStyle ${JSON.stringify(obj.bashInputStyle)} in ${preferencesPath()}: expected "queue" or "interrupt". Using "${DEFAULT_BASH_INPUT_STYLE}".`;
        current = DEFAULT_BASH_INPUT_STYLE;
        return current;
    }

    current = obj.bashInputStyle;
    return current;
}

/**
 * Persist a style to disk, atomically, preserving any unknown keys already in
 * the file so future keys and out-of-band edits are not wiped.
 *
 * Atomic means write-to-temp-then-rename within the same directory: a
 * concurrent reader sees either the whole old file or the whole new one, never
 * a truncated one.
 */
export async function writePreferences(style: BashInputStyle): Promise<void> {
    const path = preferencesPath();

    let existing: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            existing = parsed as Record<string, unknown>;
        }
    } catch {
        // No readable/parseable file to preserve keys from — start clean.
    }

    const next = {
        ...existing,
        schemaVersion: PREFERENCES_SCHEMA_VERSION,
        bashInputStyle: style,
    };

    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
    await rename(tmp, path);
}
