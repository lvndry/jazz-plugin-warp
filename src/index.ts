/**
 * A Jazz notification plugin that raises normal native OS notifications when a task finishes or
 * Jazz is waiting for the next message.
 *
 * This deliberately does not write terminal escape sequences, so Warp does not show its own
 * in-terminal notification modal. Notifications are best-effort and fire-and-forget; failures are
 * swallowed so nothing here can delay or break a run. Set `JAZZ_WARP_SILENT=1` to suppress them.
 */

import { spawn } from "node:child_process";
import type { JazzPluginModule, LifecycleEvent } from "@jazz/plugin-sdk";

const MAX_BODY_CHARS = 200;

export interface Notification {
  readonly title: string;
  readonly body: string;
}

/** Keep notification previews short enough for OS notification banners. */
function preview(value: string): string {
  return value.trim().slice(0, MAX_BODY_CHARS);
}

function summaryFrom(event: LifecycleEvent): string {
  return typeof event.data?.["summary"] === "string" ? preview(event.data["summary"]) : "";
}

export function notificationFor(
  event: LifecycleEvent,
  previousResponse?: string,
): Notification | undefined {
  switch (event.event) {
    case "run-complete": {
      const summary = summaryFrom(event);
      return {
        title: "Jazz — task complete",
        body: summary.length > 0 ? summary : "The agent finished the task.",
      };
    }
    case "awaiting-input":
      return {
        title: "Jazz — waiting for you",
        body:
          previousResponse === undefined
            ? "The agent is ready for your next message."
            : preview(previousResponse),
      };
    default:
      return undefined;
  }
}

export type NotificationPlan =
  | { readonly kind: "silent" }
  | { readonly kind: "desktop"; readonly title: string; readonly body: string };

export function planNotification(
  event: LifecycleEvent,
  previousResponse?: string,
): NotificationPlan {
  if (process.env["JAZZ_WARP_SILENT"] === "1") {
    return { kind: "silent" };
  }
  const notification = notificationFor(event, previousResponse);
  return notification === undefined
    ? { kind: "silent" }
    : { kind: "desktop", title: notification.title, body: notification.body };
}

function emitDesktopNotification(title: string, body: string): void {
  try {
    if (process.platform === "darwin") {
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
      const child = spawn("osascript", ["-e", script], { stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    } else if (process.platform === "linux") {
      const child = spawn("notify-send", [title, body], { stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    }
  } catch {
    // Best-effort: a missing notifier or unsupported OS must never surface to the run.
  }
}

const previousResponses = new Map<string, string>();

function responseKey(event: LifecycleEvent): string {
  return `${event.agentId}\u0000${event.conversationId}`;
}

function rememberResponse(event: LifecycleEvent): void {
  if (event.event !== "run-complete") return;
  const key = responseKey(event);
  const summary = summaryFrom(event);
  if (summary.length === 0) previousResponses.delete(key);
  else previousResponses.set(key, summary);
}

/** Emit a native OS notification. The optional writer is retained for host ABI compatibility but intentionally unused. */
export function notify(
  event: LifecycleEvent,
  _writeSequence?: (data: string) => void,
): void {
  const previousResponse = previousResponses.get(responseKey(event));
  const plan = planNotification(event, previousResponse);
  rememberResponse(event);
  if (plan.kind === "desktop") {
    emitDesktopNotification(plan.title, plan.body);
  }
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
