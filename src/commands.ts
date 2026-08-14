/**
 * 슬래시 커맨드 등록.
 *
 *   - /bg: Ctrl+Shift+B와 동일 — 포그라운드 프로세스를 백그라운드로
 *   - /bg-list: 인터랙티브 백그라운드 작업 매니저 열기
 *   - /bg-version: 현재 로드된 확장 버전/경로 확인
 *   - /bg-prefs: 배경 작업 환경설정 (bash 입력 스타일)
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import { takeControl, type ControlContext } from "./lifecycle.ts";
import { openBgListPanel } from "./ui.ts";
import {
    getBashInputStyle,
    loadPreferences,
    preferencesPath,
    setBashInputStyle,
    writePreferences,
    type BashInputStyle,
} from "./preferences.ts";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageRoot = dirname(packageJsonPath);

/** 모든 슬래시 커맨드를 등록한다. */
export function registerCommands(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    pi.registerCommand("bg", {
        description: "Background the current process and hand control to the agent",
        handler: async (_args, ctx) => {
            takeControl(reg, pi, ctx as unknown as ControlContext);
        },
    });

    pi.registerCommand("bg-list", {
        description: "Open the interactive background task manager",
        handler: async (_args, ctx: ExtensionCommandContext) => {
            await openBgListPanel(reg, ctx);
        },
    });

    pi.registerCommand("bg-version", {
        description: "Show the loaded background tasks extension version",
        handler: async (_args, ctx) => {
            const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
                name?: string;
                version?: string;
            };
            ctx.ui.notify(
                `${pkg.name ?? "pi-patty-bg-tasks"}@${pkg.version ?? "unknown"} loaded from ${packageRoot}`,
                "info"
            );
        },
    });

    // A single select() picker rather than a full SettingsList: one toggle does
    // not warrant the extra surface, and select() is the same primitive
    // /bg-list already uses, so it works in command and shortcut contexts and
    // in RPC mode. If more preferences land, upgrading is a local change here.
    //
    // Named /bg-prefs rather than /prefs or /settings: Pi has a built-in
    // /settings, and the bg- prefix matches this extension's command family.
    pi.registerCommand("bg-prefs", {
        description: "Background tasks preferences (bash input style)",
        handler: async (_args, ctx) => {
            const style = getBashInputStyle();
            const QUEUE = "Queue — steer at the next turn (default; command keeps running)";
            const INTERRUPT = "Interrupt — background the command and start a new turn";
            const RELOAD = "Reload from disk";

            const choice = await ctx.ui.select(
                `Bash input style (currently: ${style})`,
                [QUEUE, INTERRUPT, RELOAD]
            );

            // Esc / cancel changes nothing.
            if (choice === undefined) return;

            if (choice === RELOAD) {
                const resolved = await loadPreferences();
                ctx.ui.notify(
                    `Reloaded ${preferencesPath()} — bash input style: ${resolved}`,
                    "info"
                );
                return;
            }

            const next: BashInputStyle = choice === INTERRUPT ? "interrupt" : "queue";
            try {
                await writePreferences(next);
            } catch (err) {
                ctx.ui.notify(
                    `Could not write ${preferencesPath()}: ${err instanceof Error ? err.message : String(err)}`,
                    "error"
                );
                return;
            }
            // Update memory only after the write succeeded, so a failed write
            // never leaves the session disagreeing with the file.
            setBashInputStyle(next);
            ctx.ui.notify(`Bash input style: ${next}`, "info");
        },
    });
}
