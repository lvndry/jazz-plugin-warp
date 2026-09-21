/**
 * A Warp notification plugin for Jazz. When a task finishes or Jazz is waiting for you, it raises a
 * desktop notification bound to the exact Warp tab the agent is running in.
 *
 * Under Warp it emits an OSC 777 escape sequence to the terminal's own stream
 * (`\e]777;notify;warp://cli-agent;<json>\a`), so Warp receives it on that tab's byte stream and
 * binds the notification to the originating tab — the same mechanism as warpdotdev/claude-code-warp.
 * Off Warp it falls back to a native OS notification (osascript / notify-send).
 *
 * Everything is best-effort and fire-and-forget: failures are swallowed, so nothing here can delay
 * or break a run. Set `JAZZ_WARP_SILENT=1` to suppress all notifications.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { JazzPluginModule, LifecycleEvent, LifecycleEventId } from "@jazz/plugin-sdk";

export interface Notification {
  readonly title: string;
  readonly body: string;
}

const MAX_BODY_CHARS = 200;

/** The protocol version this plugin produces; negotiated down to Warp's if Warp advertises lower. */
const PLUGIN_PROTOCOL_VERSION = 1;

/** OSC 777 desktop-notification sequence: `ESC ] 777 ; notify ; <title> ; <body> BEL`. */
const OSC_NOTIFY_PREFIX = "\u001b]777;notify;";
const OSC_TERMINATOR = "\u0007";

/**
 * Last Warp release per channel that advertised the CLI-agent protocol without being able to render
 * structured notifications; at or before these, fall back to a plain notification.
 */
const LAST_BROKEN_STRUCTURED: Readonly<Record<string, string>> = {
  stable: "v0.2026.03.25.08.24.stable_05",
  preview: "v0.2026.03.25.08.24.preview_05",
};

/** The plain-notification title/body for a lifecycle event, or undefined for ones we don't announce. */
export function notificationFor(event: LifecycleEvent): Notification | undefined {
  switch (event.event) {
    case "run-complete": {
      const summary =
        typeof event.data?.["summary"] === "string" ? event.data["summary"].trim() : "";
      return {
        title: "Jazz — task complete",
        body:
          summary.length > 0 ? summary.slice(0, MAX_BODY_CHARS) : "The agent finished the task.",
      };
    }
    case "awaiting-input":
      return { title: "Jazz — waiting for you", body: "The agent is ready for your next message." };
    default:
      return undefined;
  }
}

/** Warp's own event name for a lifecycle event, or undefined for ones we don't announce. */
export function warpEventName(event: LifecycleEventId): "stop" | "notification" | undefined {
  switch (event) {
    case "run-complete":
      return "stop";
    case "awaiting-input":
      return "notification";
    default:
      return undefined;
  }
}

function isWarpTerminal(): boolean {
  return process.env["TERM_PROGRAM"] === "WarpTerminal";
}

/**
 * Whether this Warp build can render structured `warp://cli-agent` notifications. Requires an
 * advertised protocol version and a client version past the last broken release for its channel.
 */
export function supportsStructuredWarp(): boolean {
  if (process.env["WARP_CLI_AGENT_PROTOCOL_VERSION"] === undefined) return false;
  const clientVersion = process.env["WARP_CLIENT_VERSION"];
  if (clientVersion === undefined || clientVersion.length === 0) return false;
  const channel = clientVersion.includes("dev")
    ? "dev"
    : clientVersion.includes("stable")
      ? "stable"
      : clientVersion.includes("preview")
        ? "preview"
        : undefined;
  if (channel === undefined) return true;
  const threshold = LAST_BROKEN_STRUCTURED[channel];
  if (threshold === undefined) return true;
  return clientVersion > threshold;
}

function negotiatedProtocolVersion(): number {
  const advertised = Number(process.env["WARP_CLI_AGENT_PROTOCOL_VERSION"]);
  return Number.isInteger(advertised) && advertised < PLUGIN_PROTOCOL_VERSION
    ? advertised
    : PLUGIN_PROTOCOL_VERSION;
}

/** The `warp://cli-agent` JSON payload for a lifecycle event, carrying session id, cwd, and project. */
export function structuredPayload(event: LifecycleEvent, warpEvent: "stop" | "notification"): string {
  const cwd = event.cwd;
  const summary = typeof event.data?.["summary"] === "string" ? event.data["summary"].trim() : "";
  const payload: Record<string, unknown> = {
    v: negotiatedProtocolVersion(),
    agent: "jazz",
    event: warpEvent,
    session_id: event.conversationId,
    cwd,
    project: cwd.split("/").filter((segment) => segment.length > 0).pop() ?? "",
  };
  if (warpEvent === "stop" && summary.length > 0) payload["response"] = summary.slice(0, MAX_BODY_CHARS);
  return JSON.stringify(payload);
}

/** What the plugin will do for a lifecycle event, decided purely from the event and environment. */
export type NotificationPlan =
  | { readonly kind: "silent" }
  | { readonly kind: "warp"; readonly sequence: string }
  | { readonly kind: "desktop"; readonly title: string; readonly body: string };

/**
 * Decide how to notify for a lifecycle event. Under Warp it produces the OSC 777 sequence to emit
 * (`warp://cli-agent` when the build supports structured notifications, otherwise a plain one);
 * off Warp it asks for a native desktop notification; and it stays silent for unannounced events
 * or under JAZZ_WARP_SILENT.
 */
export function planNotification(event: LifecycleEvent): NotificationPlan {
  if (process.env["JAZZ_WARP_SILENT"] === "1") {
    return { kind: "silent" };
  }
  const notification = notificationFor(event);
  if (notification === undefined) {
    return { kind: "silent" };
  }
  if (!isWarpTerminal()) {
    return { kind: "desktop", title: notification.title, body: notification.body };
  }
  const warpEvent = warpEventName(event.event);
  const payload =
    warpEvent !== undefined && supportsStructuredWarp()
      ? `warp://cli-agent;${structuredPayload(event, warpEvent)}`
      : `${notification.title};${notification.body}`;
  return { kind: "warp", sequence: `${OSC_NOTIFY_PREFIX}${payload}${OSC_TERMINATOR}` };
}

/**
 * Write an OSC sequence to the controlling terminal so it binds to this tab. A host running a
 * fullscreen TUI owns process.stdout and would swallow the sequence, so /dev/tty is the reliable
 * path to Warp; fall back to stdout when there is no controlling terminal.
 */
function emitTerminalSequence(sequence: string): void {
  try {
    const tty = fs.openSync("/dev/tty", "w");
    try {
      fs.writeSync(tty, sequence);
    } finally {
      fs.closeSync(tty);
    }
    return;
  } catch {
    // No controlling terminal; fall through to stdout.
  }
  try {
    process.stdout.write(sequence);
  } catch {
    // Best-effort: a closed or non-writable stdout must never surface to the run.
  }
}

/** Raise a native OS notification, out-of-band, for terminals that are not Warp. */
function emitDesktopNotification(title: string, body: string): void {
  try {
    if (process.platform === "darwin") {
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
      spawn("osascript", ["-e", script], { stdio: "ignore" }).unref();
    } else if (process.platform === "linux") {
      spawn("notify-send", [title, body], { stdio: "ignore" }).unref();
    }
  } catch {
    // Best-effort: a missing notifier binary must never surface to the run.
  }
}

/**
 * Deliver the notification for a lifecycle event by the best route for the current terminal. Under
 * Warp it prefers the host's `writeTerminalSequence` (which targets the controlling terminal even
 * behind a fullscreen TUI); when the host does not provide one — an older Jazz — it writes the
 * controlling terminal itself.
 */
export function notify(event: LifecycleEvent, writeSequence?: (data: string) => void): void {
  const plan = planNotification(event);
  if (plan.kind === "warp") {
    (writeSequence ?? emitTerminalSequence)(plan.sequence);
  } else if (plan.kind === "desktop") {
    emitDesktopNotification(plan.title, plan.body);
  }
}

const plugin: JazzPluginModule = {
  apiVersion: 1,
  register(api) {
    for (const event of ["run-complete", "awaiting-input"] as const) {
      api.lifecycle.register({
        event,
        handler: (received, context) => {
          notify(received, context.writeTerminalSequence);
          return Promise.resolve();
        },
      });
    }
  },
};

export default plugin;
