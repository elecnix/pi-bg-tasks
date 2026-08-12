// src/input.ts
//
// pi-bg-tasks fork: the input handler is intentionally a no-op.
//
// The upstream patty-io/pi-patty-bg-tasks extension intercepts user input typed
// while a foreground bash command is running, backgrounds the command, aborts
// the current turn, and re-injects the message as a fresh turn — "cooperative
// steering" / Claude Code parity. This fork drops that default: typing during a
// running bash command does NOT abort it. Pi's native steering applies instead,
// which queues the message and delivers it at the next turn boundary. The
// command keeps running (auto-background after 120s, Ctrl+B, and the rest of
// the package are unaffected).
//
// The handler is still registered so the rest of the extension wiring is
// unchanged; it simply declines to intercept and lets Pi proceed.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";

export function registerInputHandlers(_pi: ExtensionAPI, _reg: BackgroundRegistry): void {
    _pi.on("input", async () => {
        // Fork change: never intercept — fall through to Pi's native steering.
        return { action: "continue" } as const;
    });
}