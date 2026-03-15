import { buildDebugRunLogTree } from "../debug-run-log.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { SessionsListResult } from "../types.ts";
import type { SessionLogEntry } from "../views/usage.ts";

export type DebugRunLogState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
  debugRunLogRootKey: string;
  debugRunLogLoading: boolean;
  debugRunLogError: string | null;
  debugRunLogLogsByKey: Record<string, SessionLogEntry[] | null>;
};

function toErrorMessage(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return "request failed";
}

export function resolveDebugRunLogRootKey(
  state: Pick<DebugRunLogState, "sessionKey" | "debugRunLogRootKey">,
): string {
  const configured = state.debugRunLogRootKey.trim();
  if (configured) {
    return configured;
  }
  return state.sessionKey.trim();
}

export async function loadDebugRunLog(state: DebugRunLogState, overrides?: { rootKey?: string }) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  if (state.debugRunLogLoading) {
    return;
  }

  const rootKey = (overrides?.rootKey ?? resolveDebugRunLogRootKey(state)).trim();
  if (!rootKey) {
    return;
  }

  state.debugRunLogRootKey = rootKey;
  state.debugRunLogLoading = true;
  state.debugRunLogError = null;

  const sessionTree = buildDebugRunLogTree(rootKey, state.sessionsResult?.sessions ?? []);
  const sessionKeys = Array.from(new Set(sessionTree.map((entry) => entry.key)));
  if (sessionKeys.length === 0) {
    sessionKeys.push(rootKey);
  }

  try {
    const results = await Promise.all(
      sessionKeys.map(async (key) => {
        try {
          const response = await client.request<{ logs?: SessionLogEntry[] }>(
            "sessions.usage.logs",
            {
              key,
              limit: 1000,
            },
          );
          const logs = Array.isArray(response?.logs) ? response.logs : [];
          return [key, logs] as const;
        } catch {
          return [key, null] as const;
        }
      }),
    );
    state.debugRunLogLogsByKey = Object.fromEntries(results);
  } catch (err) {
    state.debugRunLogError = toErrorMessage(err);
  } finally {
    state.debugRunLogLoading = false;
  }
}
