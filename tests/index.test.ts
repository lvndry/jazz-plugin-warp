/** Exercises the Warp plugin's notification logic, tab-bound OSC emission, and lifecycle wiring. */

import type {
  JazzPluginModule,
  LifecycleEvent,
  PluginHostApi,
  PluginLifecycleRegistration,
} from "@jazz/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import plugin, {
  notificationFor,
  planNotification,
  structuredPayload,
  supportsStructuredWarp,
  warpEventName,
} from "../src/index";

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

const WARP_ENV = [
  "TERM_PROGRAM",
  "WARP_CLI_AGENT_PROTOCOL_VERSION",
  "WARP_CLIENT_VERSION",
  "JAZZ_WARP_SILENT",
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(WARP_ENV.map((key) => [key, process.env[key]]));
  for (const key of WARP_ENV) delete process.env[key];
});

afterEach(() => {
  for (const key of WARP_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function underStructuredWarp(): void {
  process.env["TERM_PROGRAM"] = "WarpTerminal";
  process.env["WARP_CLI_AGENT_PROTOCOL_VERSION"] = "1";
  process.env["WARP_CLIENT_VERSION"] = "v0.2026.09.01.00.00.stable_01";
}

describe("notificationFor", () => {
  it("builds a task-complete notification from the run summary", () => {
    expect(notificationFor(event({ event: "run-complete", data: { summary: "  Shipped.  " } }))).toEqual({
      title: "Jazz — task complete",
      body: "Shipped.",
    });
  });

  it("falls back to a default body and announces awaiting-input", () => {
    expect(notificationFor(event({ event: "run-complete" }))?.body).toBe("The agent finished the task.");
    expect(notificationFor(event({ event: "awaiting-input" }))?.title).toBe("Jazz — waiting for you");
    expect(notificationFor(event({ event: "session-start" }))).toBeUndefined();
  });
});

describe("warpEventName", () => {
  it("maps lifecycle events to Warp event names", () => {
    expect(warpEventName("run-complete")).toBe("stop");
    expect(warpEventName("awaiting-input")).toBe("notification");
    expect(warpEventName("session-start")).toBeUndefined();
  });
});

describe("supportsStructuredWarp", () => {
  it("requires an advertised protocol and a client version past the broken threshold", () => {
    expect(supportsStructuredWarp()).toBe(false);
    process.env["WARP_CLI_AGENT_PROTOCOL_VERSION"] = "1";
    expect(supportsStructuredWarp()).toBe(false); // no client version
    process.env["WARP_CLIENT_VERSION"] = "v0.2026.03.25.08.24.stable_05"; // exactly the broken one
    expect(supportsStructuredWarp()).toBe(false);
    process.env["WARP_CLIENT_VERSION"] = "v0.2026.09.01.00.00.stable_01";
    expect(supportsStructuredWarp()).toBe(true);
  });
});

describe("structuredPayload", () => {
  it("carries session id, cwd, project, and the response summary", () => {
    underStructuredWarp();
    const payload = JSON.parse(
      structuredPayload(
        event({ event: "run-complete", conversationId: "sess-1", data: { summary: "done" } }),
        "stop",
      ),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      v: 1,
      agent: "jazz",
      event: "stop",
      session_id: "sess-1",
      cwd: "/home/dev/project",
      project: "project",
      response: "done",
    });
  });
});

describe("planNotification", () => {
  it("plans a tab-bound warp://cli-agent OSC sequence under structured Warp", () => {
    underStructuredWarp();
    const plan = planNotification(
      event({ event: "run-complete", conversationId: "sess-9", data: { summary: "ok" } }),
    );
    expect(plan.kind).toBe("warp");
    const sequence = plan.kind === "warp" ? plan.sequence : "";
    expect(sequence.startsWith("\u001b]777;notify;warp://cli-agent;")).toBe(true);
    expect(sequence.endsWith("\u0007")).toBe(true);
    expect(sequence).toContain('"session_id":"sess-9"');
  });

  it("plans a plain OSC notification under Warp without structured support", () => {
    process.env["TERM_PROGRAM"] = "WarpTerminal";
    expect(planNotification(event({ event: "awaiting-input" }))).toEqual({
      kind: "warp",
      sequence:
        "\u001b]777;notify;Jazz — waiting for you;The agent is ready for your next message.\u0007",
    });
  });

  it("plans a desktop notification off Warp", () => {
    const plan = planNotification(event({ event: "run-complete", data: { summary: "ok" } }));
    expect(plan).toEqual({ kind: "desktop", title: "Jazz — task complete", body: "ok" });
  });

  it("stays silent under JAZZ_WARP_SILENT and for unannounced events", () => {
    underStructuredWarp();
    process.env["JAZZ_WARP_SILENT"] = "1";
    expect(planNotification(event({ event: "run-complete", data: { summary: "ok" } }))).toEqual({
      kind: "silent",
    });
    delete process.env["JAZZ_WARP_SILENT"];
    expect(planNotification(event({ event: "session-start" }))).toEqual({ kind: "silent" });
  });
});

describe("plugin registration", () => {
  it("subscribes to run-complete and awaiting-input, and handlers resolve", async () => {
    process.env["JAZZ_WARP_SILENT"] = "1";
    const lifecycle = register();
    expect([...lifecycle.keys()].sort()).toEqual(["awaiting-input", "run-complete"]);
    await expect(
      lifecycle
        .get("run-complete")!
        .handler(event({ event: "run-complete", data: { summary: "done" } }), {
          signal: new AbortController().signal,
        }),
    ).resolves.toBeUndefined();
  });
});
