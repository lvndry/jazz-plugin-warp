/**
 * A Warp notification plugin for Jazz. When a task finishes or Jazz is waiting for you, it raises a
 * notification bound to the Warp tab the agent is running in.
 *
 * Under Warp it emits a structured OSC 777 `warp://cli-agent` escape sequence so Warp delivers
 * both in-app tab notifications and macOS notification center entries. Off Warp it falls back to
 * a native OS notification (osascript / notify-send).
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

const PLUGIN_PROTOCOL_VERSION = 1;

const OSC_NOTIFY_PREFIX = "\u001b]777;notify;";
const OSC_TERMINATOR = "\u0007";

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

function negotiatedProtocolVersion(): number {
  const advertised = Number(process.env["WARP_CLI_AGENT_PROTOCOL_VERSION"]);
  return Number.isInteger(advertised) && advertised < PLUGIN_PROTOCOL_VERSION
    ? advertised
    : PLUGIN_PROTOCOL_VERSION;
}

export function structuredPayload(event: LifecycleEvent, warpEvent: "stop" | "notification"): string {
  const cwd = event.cwd;
  const summary = typeof event.data?.["summary"] === "string" ? event.data["summary"].trim() : "";
  const payload: Record<string, unknown> = {
    v: negotiatedProtocolVersion(),
    agent: "droid",
    event: warpEvent,
    session_id: event.conversationId,
    cwd,
    project: cwd.split("/").filter((segment) => segment.length > 0).pop() ?? "",
  };
  if (warpEvent === "stop" && summary.length > 0) {
    payload["response"] = summary.slice(0, MAX_BODY_CHARS);
  }
  return JSON.stringify(payload);
}

export type NotificationPlan =
  | { readonly kind: "silent" }
  | { readonly kind: "warp"; readonly sequence: string }
  | { readonly kind: "desktop"; readonly title: string; readonly body: string };

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
    warpEvent !== undefined
      ? `warp://cli-agent;${structuredPayload(event, warpEvent)}`
      : `${notification.title};${notification.body}`;
  return { kind: "warp", sequence: `${OSC_NOTIFY_PREFIX}${payload}${OSC_TERMINATOR}` };
}

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
