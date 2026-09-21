/**
 * A Warp notification plugin for Jazz. It uses Warp's documented OSC 777 notification format so
 * Warp owns the notification and can deliver it through its normal desktop notification settings.
 *
 * This intentionally uses the generic title/body form rather than the allowlisted
 * `warp://cli-agent` rich-agent protocol: Jazz is not pretending to be another registered agent.
 * Everything is best-effort and fire-and-forget. Set `JAZZ_WARP_SILENT=1` to suppress notifications.
 */

import type { JazzPluginModule, LifecycleEvent } from "@jazz/plugin-sdk";

const MAX_BODY_CHARS = 200;
const OSC_NOTIFY_PREFIX = "\u001b]777;notify;";
const OSC_TERMINATOR = "\u0007";

export interface Notification {
  readonly title: string;
  readonly body: string;
}

/** Keep previews short and safe for OSC's title/body separators. */
function preview(value: string): string {
  return value.replace(/\s+/g, " ").replaceAll(";", ",").trim().slice(0, MAX_BODY_CHARS);
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

function isWarpTerminal(): boolean {
  return process.env["TERM_PROGRAM"] === "WarpTerminal";
}

function oscSequence(notification: Notification): string {
  return `${OSC_NOTIFY_PREFIX}${notification.title};${notification.body}${OSC_TERMINATOR}`;
}

export type NotificationPlan =
  | { readonly kind: "silent" }
  | { readonly kind: "warp"; readonly sequence: string };

export function planNotification(
  event: LifecycleEvent,
  previousResponse?: string,
): NotificationPlan {
  if (process.env["JAZZ_WARP_SILENT"] === "1" || !isWarpTerminal()) {
    return { kind: "silent" };
  }
  const notification = notificationFor(event, previousResponse);
  return notification === undefined
    ? { kind: "silent" }
    : { kind: "warp", sequence: oscSequence(notification) };
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

export function notify(
  event: LifecycleEvent,
  writeSequence?: (data: string) => void,
): void {
  const previousResponse = previousResponses.get(responseKey(event));
  const plan = planNotification(event, previousResponse);
  rememberResponse(event);
  if (plan.kind === "warp") {
    writeSequence?.(plan.sequence);
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
