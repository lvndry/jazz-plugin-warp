/** Exercises native notification planning, response previews, and lifecycle wiring. */

import type {
  JazzPluginModule,
  LifecycleEvent,
  PluginHostApi,
  PluginLifecycleRegistration,
} from "@jazz/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import plugin, { notificationFor, notify, planNotification } from "../src/index";

function event(overrides: Partial<LifecycleEvent> & Pick<LifecycleEvent, "event">): LifecycleEvent {
  return { agentId: "a", conversationId: "c", cwd: "/home/dev/project", ...overrides };
}

function register(): Map<string, PluginLifecycleRegistration> {
  const lifecycle = new Map<string, PluginLifecycleRegistration>();
  const api = {
    apiVersion: 1,
    hooks: { register: () => {} },
    decisions: {
      registerProvider: () => {
        throw new Error("not used");
      },
    },
    tools: { register: () => {} },
    commands: { register: () => {} },
    lifecycle: {
      register: (registration: PluginLifecycleRegistration) => {
        lifecycle.set(registration.event, registration);
      },
    },
    secrets: { get: async () => undefined },
  } as unknown as PluginHostApi;
  (plugin as JazzPluginModule).register(api);
  return lifecycle;
}

beforeEach(() => {
  delete process.env["JAZZ_WARP_SILENT"];
});

afterEach(() => {
  delete process.env["JAZZ_WARP_SILENT"];
});

describe("notificationFor", () => {
  it("builds a task-complete notification from the run summary", () => {
    expect(notificationFor(event({ event: "run-complete", data: { summary: "  Shipped.  " } }))).toEqual({
      title: "Jazz — task complete",
      body: "Shipped.",
    });
  });

  it("uses a previous response for awaiting-input and clips it", () => {
    const response = "x".repeat(250);
    expect(notificationFor(event({ event: "awaiting-input" }), response)).toEqual({
      title: "Jazz — waiting for you",
      body: response.slice(0, 200),
    });
    expect(notificationFor(event({ event: "awaiting-input" }))?.body).toBe(
      "The agent is ready for your next message.",
    );
  });

  it("ignores lifecycle events without notifications", () => {
    expect(notificationFor(event({ event: "session-start" }))).toBeUndefined();
  });
});

describe("planNotification", () => {
  it("always plans a native desktop notification, including under Warp", () => {
    process.env["TERM_PROGRAM"] = "WarpTerminal";
    expect(planNotification(event({ event: "run-complete", data: { summary: "ok" } }))).toEqual({
      kind: "desktop",
      title: "Jazz — task complete",
      body: "ok",
    });
  });

  it("stays silent when disabled or for unannounced events", () => {
    process.env["JAZZ_WARP_SILENT"] = "1";
    expect(planNotification(event({ event: "run-complete" }))).toEqual({ kind: "silent" });
    delete process.env["JAZZ_WARP_SILENT"];
    expect(planNotification(event({ event: "session-start" }))).toEqual({ kind: "silent" });
  });
});

describe("native notification wiring", () => {
  it("uses the previous run response for the next awaiting-input event without writing to Warp", () => {
    process.env["TERM_PROGRAM"] = "WarpTerminal";
    const written: string[] = [];
    const conversationId = "preview-session";

    notify(
      event({ event: "run-complete", conversationId, data: { summary: "The change is ready." } }),
      (data) => written.push(data),
    );
    notify(event({ event: "awaiting-input", conversationId }), (data) => written.push(data));

    expect(written).toEqual([]);
  });
});

describe("plugin registration", () => {
  it("subscribes to run-complete and awaiting-input", () => {
    const lifecycle = register();
    expect([...lifecycle.keys()].sort()).toEqual(["awaiting-input", "run-complete"]);
  });
});
