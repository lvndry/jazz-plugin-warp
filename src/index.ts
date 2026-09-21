/**
 * A Warp notification plugin for Jazz. When a task finishes or Jazz is waiting for you, it raises
 * notifications through two channels:
 *
 * 1. A plain OSC 777 escape sequence for in-Warp tab notifications
 * 2. An osascript/notify-send call for macOS/Linux desktop notifications
 *
 * Off Warp it falls back to desktop notifications only.
 *
 * Everything is best-effort and fire-and-forget: failures are swallowed, so nothing here can delay
 * or break a run. Set `JAZZ_WARP_SILENT=1` to suppress all notifications.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { JazzPluginModule, LifecycleEvent } from "@jazz/plugin-sdk";

export interface Notification {
  readonly title: string;
  readonly body: string;
}

const MAX_BODY_CHARS = 200;

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

function isWarpTerminal(): boolean {
  return process.env["TERM_PROGRAM"] === "WarpTerminal";
}

function plainOscSequence(title: string, body: string): string {
  return `${OSC_NOTIFY_PREFIX}${title};${body}${OSC_TERMINATOR}`;
}

export type NotificationPlan =
  | { readonly kind: "silent" }
  | { readonly kind: "warp-dual"; readonly sequence: string; readonly title: string; readonly body: string }
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
  return {
    kind: "warp-dual",
    sequence: plainOscSequence(notification.title, notification.body),
    title: notification.title,
    body: notification.body,
  };
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
    // Best-effort.
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
    // Best-effort.
  }
}

export function notify(event: LifecycleEvent, writeSequence?: (data: string) => void): void {
  const plan = planNotification(event);
  if (plan.kind === "warp-dual") {
    (writeSequence ?? emitTerminalSequence)(plan.sequence);
    emitDesktopNotification(plan.title, plan.body);
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
