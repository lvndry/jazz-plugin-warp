/** Exercises generic Warp OSC notification planning, response previews, and lifecycle wiring. */

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
  process.env["TERM_PROGRAM"] = "WarpTerminal";
  delete process.env["JAZZ_WARP_SILENT"];
});

afterEach(() => {
  delete process.env["TERM_PROGRAM"];
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
  it("plans a generic OSC 777 notification under Warp", () => {
    const plan = planNotification(event({ event: "run-complete", data: { summary: "ok" } }));
    expect(plan).toEqual({
      kind: "warp",
      sequence: "\u001b]777;notify;Jazz — task complete;ok\u0007",
    });
  });

  it("does not emit outside Warp or when disabled", () => {
    delete process.env["TERM_PROGRAM"];
    expect(planNotification(event({ event: "run-complete" }))).toEqual({ kind: "silent" });
    process.env["TERM_PROGRAM"] = "WarpTerminal";
    process.env["JAZZ_WARP_SILENT"] = "1";
    expect(planNotification(event({ event: "run-complete" }))).toEqual({ kind: "silent" });
  });
});

describe("Warp notification wiring", () => {
  it("uses the preceding response for awaiting-input and writes only the Warp sequence", () => {
    const written: string[] = [];
    const conversationId = "preview-session";

    notify(
      event({ event: "run-complete", conversationId, data: { summary: "The change is ready." } }),
      (data) => written.push(data),
    );
    notify(event({ event: "awaiting-input", conversationId }), (data) => written.push(data));

    expect(written).toEqual([
      "\u001b]777;notify;Jazz — task complete;The change is ready.\u0007",
      "\u001b]777;notify;Jazz — waiting for you;The change is ready.\u0007",
    ]);
  });
});

describe("plugin registration", () => {
  it("subscribes to run-complete and awaiting-input and routes sequences to Warp", async () => {
    const lifecycle = register();
    expect([...lifecycle.keys()].sort()).toEqual(["awaiting-input", "run-complete"]);
    const written: string[] = [];
    await lifecycle.get("run-complete")!.handler(
      event({ event: "run-complete", data: { summary: "done" } }),
      {
        signal: new AbortController().signal,
        writeTerminalSequence: (data) => written.push(data),
      },
    );
    expect(written).toEqual(["\u001b]777;notify;Jazz — task complete;done\u0007"]);
  });
});
