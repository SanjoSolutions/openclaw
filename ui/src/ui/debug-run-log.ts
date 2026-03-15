import type { EventLogEntry } from "./app-events.ts";
import type { GatewaySessionRow } from "./types.ts";

export type DebugRunLogSessionRef = {
  key: string;
  depth: number;
  row?: GatewaySessionRow;
};

function normalizeSessionKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function sessionSortKey(row: GatewaySessionRow): [number, string] {
  return [row.updatedAt ?? 0, row.key];
}

export function buildDebugRunLogTree(
  rootKey: string,
  sessions: GatewaySessionRow[],
): DebugRunLogSessionRef[] {
  const normalizedRootKey = normalizeSessionKey(rootKey);
  if (!normalizedRootKey) {
    return [];
  }

  const rowByKey = new Map<string, GatewaySessionRow>();
  const childrenByKey = new Map<string, GatewaySessionRow[]>();
  for (const row of sessions) {
    rowByKey.set(row.key, row);
    const parentKey = normalizeSessionKey(row.spawnedBy);
    if (!parentKey) {
      continue;
    }
    const list = childrenByKey.get(parentKey) ?? [];
    list.push(row);
    childrenByKey.set(parentKey, list);
  }

  for (const list of childrenByKey.values()) {
    list.sort((a, b) => {
      const [aUpdatedAt, aKey] = sessionSortKey(a);
      const [bUpdatedAt, bKey] = sessionSortKey(b);
      if (aUpdatedAt !== bUpdatedAt) {
        return bUpdatedAt - aUpdatedAt;
      }
      return aKey.localeCompare(bKey);
    });
  }

  const ordered: DebugRunLogSessionRef[] = [];
  const visited = new Set<string>();

  const visit = (key: string, depth: number) => {
    if (visited.has(key)) {
      return;
    }
    visited.add(key);
    ordered.push({ key, depth, row: rowByKey.get(key) });
    const children = childrenByKey.get(key) ?? [];
    for (const child of children) {
      visit(child.key, depth + 1);
    }
  };

  visit(normalizedRootKey, 0);
  return ordered;
}

function collectPayloadSessionKeys(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const entry = payload as Record<string, unknown>;
  const keys = new Set<string>();

  const directKeys = [entry.sessionKey, entry.key, entry.childSessionKey, entry.parentSessionKey];
  for (const candidate of directKeys) {
    const normalized = normalizeSessionKey(candidate);
    if (normalized) {
      keys.add(normalized);
    }
  }

  const nestedEntry = entry.entry;
  if (nestedEntry && typeof nestedEntry === "object") {
    const nestedKey = normalizeSessionKey((nestedEntry as Record<string, unknown>).key);
    if (nestedKey) {
      keys.add(nestedKey);
    }
  }

  return Array.from(keys);
}

export function filterDebugRunLogEvents(
  events: EventLogEntry[],
  sessionKeys: Iterable<string>,
): EventLogEntry[] {
  const normalizedKeys = new Set(
    Array.from(sessionKeys)
      .map((entry) => normalizeSessionKey(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );
  if (normalizedKeys.size === 0) {
    return [];
  }
  return events.filter((entry) =>
    collectPayloadSessionKeys(entry.payload).some((key) => normalizedKeys.has(key)),
  );
}
