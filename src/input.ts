// src/input.ts
//
// What happens when the user types while a foreground bash command is running.
//
// Two styles, selected by the `bashInputStyle` preference (`/bg-prefs`):
//
//   "queue" (default) — decline to intercept. Pi's native steering applies:
//       the message is queued and delivered at the next turn boundary, and the
//       command keeps running. Auto-background after 120s, Ctrl+B, and the rest
//       of the package are unaffected.
//
//   "interrupt" — the upstream patty-io/pi-patty-bg-tasks "cooperative
//       steering" path: intercept before Pi queues the text, move the
//       foreground command to the background, abort the current turn, and
//       re-inject the message as a fresh turn once the agent is idle.
//
// This fork flipped the default from "interrupt" to "queue". Upstream described
// its interception as Claude Code parity; it is not. Claude Code queues typed
// input and leaves the foreground command running (measured on CC 2.1.231), so
// "queue" is what matches Claude Code. Esc kills, and Ctrl+B/timeout background,
// which this extension already matches under either style. The preference
// exists because the interrupt cadence is a legitimate taste — not because it
// is anyone's parity.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import type { UiContext } from "./types.ts";
import { backgroundActiveForeground } from "./lifecycle.ts";
import { getBashInputStyle, type BashInputStyle } from "./preferences.ts";

export function registerInputHandlers(
    pi: ExtensionAPI,
    reg: BackgroundRegistry,
    // Injected so the gate is testable without any filesystem fixtures.
    getStyle: () => BashInputStyle = getBashInputStyle
): void {
    pi.on("input", async (event, ctx) => {
        // Only ever a candidate when there is an active foreground slot.
        if (!reg.activeToolCallId) return { action: "continue" };
        if (!reg.foreground.has(reg.activeToolCallId)) return { action: "continue" };
        // Don't intercept extension-sourced messages.
        if (event.source === "extension") return { action: "continue" };

        // Preference gate, checked before any side-effectful work: under
        // "queue" the foreground slot, the abort controller and the message
        // queue are all left untouched.
        if (getStyle() !== "interrupt") return { action: "continue" };

        const text = event.text;
        const bg = backgroundActiveForeground(reg, pi, ctx as UiContext, {
            notifyAgent: false,
        });
        if (!bg) return { action: "continue" };

        // Abort the current turn so the bash tool returns the "backgrounded" result.
        ctx.abort?.();

        // Resubmit the user's message as a follow-up — Pi delivers it after the
        // current turn settles. No polling needed.
        //
        // Scope note: only `event.text` is resubmitted; `event.images` are
        // dropped. That is pre-existing upstream behavior, preserved here
        // deliberately rather than silently widened.
        try {
            pi.sendUserMessage(text, { deliverAs: "followUp" });
        } catch {
            // Session ended between abort and resubmit — nothing to deliver to.
        }

        return { action: "handled" };
    });
}
