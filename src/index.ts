/**
 * A Warp notification plugin for Jazz. When a task finishes or Jazz is waiting for you, it emits
 * a plain OSC 777 escape sequence for Warp tab notifications + macOS notification center.
 *
 * Everything is best-effort and fire-and-forget: failures are swallowed, so nothing here can delay
 * or break a run. Set `JAZZ_WARP_SILENT=1` to suppress all notifications.
 */

import * as fs from "node:fs";
import type { JazzPluginModule, LifecycleEvent } from "@jazz/plugin-sdk";

const MAX_BODY_CHARS = 200;

const OSC_NOTIFY_PREFIX = "\u001b]777;notify;";
const OSC_TERMINATOR = "\u0007";

export interface Notification {
  readonly title: string;
  readonly body: string;
}

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

function oscSequence(title: string, body: string): string {
  return `${OSC_NOTIFY_PREFIX}${title};${body}${OSC_TERMINATOR}`;
}

function isWarpTerminal(): boolean {
  return process.env["TERM_PROGRAM"] === "WarpTerminal";
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

export function notify(event: LifecycleEvent, writeSequence?: (data: string) => void): void {
  if (process.env["JAZZ_WARP_SILENT"] === "1") {
    return;
  }
  if (!isWarpTerminal()) {
    return;
  }
  const notification = notificationFor(event);
  if (notification === undefined) {
    return;
  }
  const sequence = oscSequence(notification.title, notification.body);
  (writeSequence ?? emitTerminalSequence)(sequence);
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
