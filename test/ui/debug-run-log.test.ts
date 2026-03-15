import { describe, expect, it, vi } from "vitest";
import {
  loadDebugRunLog,
  resolveDebugRunLogRootKey,
  type DebugRunLogState,
} from "../../ui/src/ui/controllers/debug-run-log.ts";
import { buildDebugRunLogTree, filterDebugRunLogEvents } from "../../ui/src/ui/debug-run-log.ts";

describe("buildDebugRunLogTree", () => {
  it("includes the root session and nested spawned sessions in depth-first order", () => {
    const tree = buildDebugRunLogTree("agent:main:main", [
      {
        key: "agent:main:subagent:older",
        spawnedBy: "agent:main:main",
        kind: "direct",
        updatedAt: 100,
      },
      {
        key: "agent:main:subagent:newer",
        spawnedBy: "agent:main:main",
        kind: "direct",
        updatedAt: 200,
      },
      {
        key: "agent:main:subagent:leaf",
        spawnedBy: "agent:main:subagent:newer",
        kind: "direct",
        updatedAt: 150,
      },
    ]);

    expect(tree).toEqual([
      { key: "agent:main:main", depth: 0, row: undefined },
      {
        key: "agent:main:subagent:newer",
        depth: 1,
        row: {
          key: "agent:main:subagent:newer",
          spawnedBy: "agent:main:main",
          kind: "direct",
          updatedAt: 200,
        },
      },
      {
        key: "agent:main:subagent:leaf",
        depth: 2,
        row: {
          key: "agent:main:subagent:leaf",
          spawnedBy: "agent:main:subagent:newer",
          kind: "direct",
          updatedAt: 150,
        },
      },
      {
        key: "agent:main:subagent:older",
        depth: 1,
        row: {
          key: "agent:main:subagent:older",
          spawnedBy: "agent:main:main",
          kind: "direct",
          updatedAt: 100,
        },
      },
    ]);
  });
});

describe("filterDebugRunLogEvents", () => {
  it("keeps only events linked to the selected session tree", () => {
    const filtered = filterDebugRunLogEvents(
      [
        {
          ts: 1,
          event: "agent",
          payload: { sessionKey: "agent:main:main", stream: "tool" },
        },
        {
          ts: 2,
          event: "chat",
          payload: { sessionKey: "agent:main:subagent:child", state: "final" },
        },
        {
          ts: 3,
          event: "presence",
          payload: { presence: [] },
        },
      ],
      ["agent:main:main", "agent:main:subagent:child"],
    );

    expect(filtered).toEqual([
      {
        ts: 1,
        event: "agent",
        payload: { sessionKey: "agent:main:main", stream: "tool" },
      },
      {
        ts: 2,
        event: "chat",
        payload: { sessionKey: "agent:main:subagent:child", state: "final" },
      },
    ]);
  });
});

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createState(
  request: RequestFn,
  overrides: Partial<DebugRunLogState> = {},
): DebugRunLogState {
  return {
    client: { request } as unknown as DebugRunLogState["client"],
    connected: true,
    sessionKey: "agent:main:main",
    sessionsResult: {
      ts: 0,
      path: "",
      count: 2,
      defaults: { model: null, contextTokens: null },
      sessions: [
        { key: "agent:main:main", kind: "direct", updatedAt: 100 },
        {
          key: "agent:main:subagent:child",
          spawnedBy: "agent:main:main",
          kind: "direct",
          updatedAt: 90,
        },
      ],
    },
    debugRunLogRootKey: "",
    debugRunLogLoading: false,
    debugRunLogError: null,
    debugRunLogLogsByKey: {},
    ...overrides,
  };
}

describe("resolveDebugRunLogRootKey", () => {
  it("falls back to the current session when no custom root is selected", () => {
    expect(
      resolveDebugRunLogRootKey({
        sessionKey: "agent:main:main",
        debugRunLogRootKey: "",
      }),
    ).toBe("agent:main:main");
  });
});

describe("loadDebugRunLog", () => {
  it("loads logs for the root session and its spawned descendants", async () => {
    const request = vi.fn(async (method: string, params?: { key?: string }) => {
      expect(method).toBe("sessions.usage.logs");
      return { logs: [{ timestamp: 1, role: "assistant", content: `log:${params?.key}` }] };
    });
    const state = createState(request);

    await loadDebugRunLog(state);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.usage.logs", {
      key: "agent:main:main",
      limit: 1000,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.usage.logs", {
      key: "agent:main:subagent:child",
      limit: 1000,
    });
    expect(state.debugRunLogLogsByKey["agent:main:main"]).toEqual([
      { timestamp: 1, role: "assistant", content: "log:agent:main:main" },
    ]);
    expect(state.debugRunLogLogsByKey["agent:main:subagent:child"]).toEqual([
      { timestamp: 1, role: "assistant", content: "log:agent:main:subagent:child" },
    ]);
    expect(state.debugRunLogLoading).toBe(false);
    expect(state.debugRunLogError).toBeNull();
  });

  it("records unavailable logs as null without failing the whole run-log refresh", async () => {
    const request = vi.fn(async (_method: string, params?: { key?: string }) => {
      if (params?.key === "agent:main:subagent:child") {
        throw new Error("missing transcript");
      }
      return { logs: [] };
    });
    const state = createState(request);

    await loadDebugRunLog(state);

    expect(state.debugRunLogLogsByKey["agent:main:main"]).toEqual([]);
    expect(state.debugRunLogLogsByKey["agent:main:subagent:child"]).toBeNull();
    expect(state.debugRunLogError).toBeNull();
  });
});
