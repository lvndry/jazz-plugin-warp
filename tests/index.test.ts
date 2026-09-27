/** Exercises generic Warp OSC notification planning, response previews, and lifecycle wiring. */

import type {
  JazzPluginModule,
  LifecycleEvent,
  PluginHostApi,
  PluginLifecycleRegistration,
} from "@jazz/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import plugin, { notificationFor, notify, planNotification } from "../src/index";
import manifest from "../jazz-plugin.json";

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
  it("names the tool requiring approval without using the previous response", () => {
    expect(notificationFor(event({ event: "permission-request", data: { tool: "write_file" } }), "Done.")).toEqual({
      title: "Jazz — approval needed",
      body: "Approve write_file to continue.",
    });
  });

  it("handles absent or invalid approval tool names", () => {
    for (const data of [undefined, {}, { tool: "  " }, { tool: 42 }]) {
      expect(notificationFor(event({ event: "permission-request", ...(data ? { data } : {}) }))?.body)
        .toBe("A tool needs your approval to continue.");
    }
  });

  it("bounds approval previews and strips terminal control characters and separators", () => {
    const notification = notificationFor(event({ event: "permission-request", data: { tool: "write;file\u0007\u001b\u009c\n" + "x".repeat(250) } }));
    expect(notification?.body.length).toBe(200);
    expect(notification?.body).toStartWith("Approve write,file ");
    expect(notification?.body).not.toMatch(/[;\u0000-\u001f\u007f-\u009f]/);
  });
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
    expect(planNotification(event({ event: "permission-request" }))).toEqual({ kind: "silent" });
    process.env["TERM_PROGRAM"] = "WarpTerminal";
    process.env["JAZZ_WARP_SILENT"] = "1";
    expect(planNotification(event({ event: "run-complete" }))).toEqual({ kind: "silent" });
    expect(planNotification(event({ event: "permission-request" }))).toEqual({ kind: "silent" });
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
  it("subscribes to every declared notification hook and routes sequences to Warp", async () => {
    const lifecycle = register();
    expect([...lifecycle.keys()].sort()).toEqual(["awaiting-input", "permission-request", "run-complete"]);
    expect([...lifecycle.keys()].sort()).toEqual([...manifest.lifecycleHooks].sort());
    const written: string[] = [];
    await lifecycle.get("run-complete")!.handler(
      event({ event: "run-complete", data: { summary: "done" } }),
      {
        signal: new AbortController().signal,
        writeTerminalSequence: (data) => written.push(data),
      },
    );
    expect(written).toEqual(["\u001b]777;notify;Jazz — task complete;done\u0007"]);
    await lifecycle.get("permission-request")!.handler(
      event({ event: "permission-request", data: { tool: "write_file", toolCallId: "call-1", riskLevel: "low-risk" } }),
      {
        signal: new AbortController().signal,
        writeTerminalSequence: (data) => written.push(data),
      },
    );
    expect(written[1]).toBe("\u001b]777;notify;Jazz — approval needed;Approve write_file to continue.\u0007");
  });
});
