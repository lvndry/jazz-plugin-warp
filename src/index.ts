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

/** Write an OSC 777 notification to the terminal's own stream, binding it to this tab. */
function emitTerminalNotification(title: string, body: string): void {
  try {
    process.stdout.write(`${OSC_NOTIFY_PREFIX}${title};${body}${OSC_TERMINATOR}`);
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

/** Deliver the notification for a lifecycle event by the best route for the current terminal. */
export function notify(event: LifecycleEvent): void {
  if (process.env["JAZZ_WARP_SILENT"] === "1") return;
  const notification = notificationFor(event);
  if (notification === undefined) return;

  if (isWarpTerminal()) {
    const warpEvent = warpEventName(event.event);
    if (warpEvent !== undefined && supportsStructuredWarp()) {
      emitTerminalNotification("warp://cli-agent", structuredPayload(event, warpEvent));
      return;
    }
    // Warp without structured support: a plain notification, still bound to this tab via the stream.
    emitTerminalNotification(notification.title, notification.body);
    return;
  }

  emitDesktopNotification(notification.title, notification.body);
}

const plugin: JazzPluginModule = {
  apiVersion: 1,
  register(api) {
    for (const event of ["run-complete", "awaiting-input"] as const) {
      api.lifecycle.register({
        event,
        handler: (received) => {
          notify(received);
          return Promise.resolve();
        },
      });
    }
  },
};

export default plugin;
