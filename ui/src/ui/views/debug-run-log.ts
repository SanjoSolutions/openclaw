import { html, nothing } from "lit";
import type { EventLogEntry } from "../app-events.ts";
import { resolveSessionDisplayName } from "../app-render.helpers.ts";
import { buildDebugRunLogTree, filterDebugRunLogEvents } from "../debug-run-log.ts";
import { formatEventPayload } from "../presenter.ts";
import type { SessionsListResult } from "../types.ts";
import type { SessionLogEntry } from "./usage.ts";

export type DebugRunLogProps = {
  currentSessionKey: string;
  rootKey: string;
  sessions: SessionsListResult | null;
  eventLog: EventLogEntry[];
  loading: boolean;
  error: string | null;
  logsByKey: Record<string, SessionLogEntry[] | null>;
  onRootKeyChange: (key: string) => void;
  onRefresh: () => void;
};

function formatTimestamp(timestamp: number): string {
  if (!timestamp) {
    return "No timestamp";
  }
  return new Date(timestamp).toLocaleString();
}

function formatTokenCount(tokens?: number): string | null {
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) {
    return null;
  }
  return `${tokens.toLocaleString()} tokens`;
}

function formatCost(cost?: number): string | null {
  if (typeof cost !== "number" || !Number.isFinite(cost)) {
    return null;
  }
  if (cost === 0) {
    return "$0";
  }
  const digits = Math.abs(cost) < 0.01 ? 4 : 2;
  return `$${cost.toFixed(digits)}`;
}

function roleLabel(role: SessionLogEntry["role"]): string {
  switch (role) {
    case "toolResult":
      return "Tool Result";
    case "tool":
      return "Tool";
    case "assistant":
      return "Assistant";
    case "user":
      return "User";
    default:
      return role;
  }
}

export function renderDebugRunLog(props: DebugRunLogProps) {
  const sessions = props.sessions?.sessions ?? [];
  const rootKey = props.rootKey.trim() || props.currentSessionKey.trim();
  const sessionRefs = buildDebugRunLogTree(rootKey, sessions);
  const sessionKeys = sessionRefs.map((entry) => entry.key);
  const rootLabel =
    rootKey &&
    resolveSessionDisplayName(
      rootKey,
      sessions.find((entry) => entry.key === rootKey),
    );
  const filteredEvents = filterDebugRunLogEvents(props.eventLog, sessionKeys).slice(0, 100);
  const rootOptions = sessions.toSorted((a, b) => {
    const aUpdatedAt = a.updatedAt ?? 0;
    const bUpdatedAt = b.updatedAt ?? 0;
    if (aUpdatedAt !== bUpdatedAt) {
      return bUpdatedAt - aUpdatedAt;
    }
    return resolveSessionDisplayName(a.key, a).localeCompare(resolveSessionDisplayName(b.key, b));
  });

  return html`
    <section class="card" style="margin-top: 18px;">
      <div class="row debug-run-log__header">
        <div>
          <div class="card-title">Run Log</div>
          <div class="card-sub">
            Inspect the active session and any spawned background-agent sessions in one tree.
            Raw live events are filtered to that tree below.
          </div>
        </div>
        <div class="debug-run-log__controls">
          <label class="field debug-run-log__field">
            <span>Root Session</span>
            <select
              .value=${rootKey}
              @change=${(event: Event) =>
                props.onRootKeyChange((event.target as HTMLSelectElement).value)}
            >
              ${rootOptions.map(
                (row) => html`
                  <option value=${row.key}>
                    ${resolveSessionDisplayName(row.key, row)}
                  </option>
                `,
              )}
            </select>
          </label>
          ${
            rootKey !== props.currentSessionKey
              ? html`
                  <button
                    class="btn"
                    type="button"
                    @click=${() => props.onRootKeyChange(props.currentSessionKey)}
                  >
                    Use current chat session
                  </button>
                `
              : nothing
          }
          <button class="btn" type="button" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      ${
        props.error
          ? html`
              <div class="callout danger" style="margin-top: 12px;">${props.error}</div>
            `
          : nothing
      }

      <div class="debug-run-log__summary">
        <span class="debug-run-log__badge">Root: ${rootLabel || rootKey || "Unknown"}</span>
        <span class="debug-run-log__badge">
          ${sessionRefs.length} session${sessionRefs.length === 1 ? "" : "s"}
        </span>
        <span class="debug-run-log__badge">
          ${filteredEvents.length} live event${filteredEvents.length === 1 ? "" : "s"}
        </span>
      </div>

      ${
        sessionRefs.length === 0
          ? html`
              <div class="muted" style="margin-top: 12px">No session tree available yet.</div>
            `
          : html`
              <div class="debug-run-log__tree">
                ${sessionRefs.map((entry) => {
                  const row = entry.row;
                  const label = resolveSessionDisplayName(entry.key, row);
                  const logs = props.logsByKey[entry.key];
                  const updatedAt = row?.updatedAt ?? null;
                  return html`
                    <details class="debug-run-log__session" open>
                      <summary
                        class="debug-run-log__session-summary"
                        style=${`--debug-depth:${entry.depth}`}
                      >
                        <div class="debug-run-log__session-title">
                          <span class="debug-run-log__session-depth">${entry.depth === 0 ? "Root" : `Child ${entry.depth}`}</span>
                          <span>${label}</span>
                        </div>
                        <div class="debug-run-log__session-meta">
                          <span class="mono">${entry.key}</span>
                          ${updatedAt ? html`<span>${formatTimestamp(updatedAt)}</span>` : nothing}
                        </div>
                      </summary>
                      <div class="debug-run-log__session-body" style=${`--debug-depth:${entry.depth}`}>
                        ${
                          logs === null
                            ? html`
                                <div class="muted">Transcript log is unavailable for this session.</div>
                              `
                            : logs && logs.length > 0
                              ? html`
                                  <div class="debug-run-log__entries">
                                    ${logs.map(
                                      (log) => html`
                                        <article class="debug-run-log__entry">
                                          <div class="debug-run-log__entry-header">
                                            <span class="debug-run-log__entry-role">
                                              ${roleLabel(log.role)}
                                            </span>
                                            <span class="debug-run-log__entry-ts">
                                              ${formatTimestamp(log.timestamp)}
                                            </span>
                                            ${
                                              formatTokenCount(log.tokens)
                                                ? html`
                                                    <span class="debug-run-log__entry-badge">
                                                      ${formatTokenCount(log.tokens)}
                                                    </span>
                                                  `
                                                : nothing
                                            }
                                            ${
                                              formatCost(log.cost)
                                                ? html`
                                                    <span class="debug-run-log__entry-badge">
                                                      ${formatCost(log.cost)}
                                                    </span>
                                                  `
                                                : nothing
                                            }
                                          </div>
                                          <pre class="code-block debug-run-log__entry-content">${log.content}</pre>
                                        </article>
                                      `,
                                    )}
                                  </div>
                                `
                              : html`
                                  <div class="muted">No transcript entries yet.</div>
                                `
                        }
                      </div>
                    </details>
                  `;
                })}
              </div>
            `
      }

      <div class="debug-run-log__events">
        <div class="card-title" style="font-size: 14px;">Run Tree Events</div>
        <div class="card-sub">
          Recent Gateway websocket events for this session tree. Tool results may still be
          truncated unless verbose mode is set to <span class="mono">full</span>.
        </div>
        ${
          filteredEvents.length === 0
            ? html`
                <div class="muted" style="margin-top: 12px">No live events captured yet.</div>
              `
            : html`
                <div class="list debug-run-log__event-list" style="margin-top: 12px;">
                  ${filteredEvents.map((event) => {
                    const sessionKey =
                      event.payload && typeof event.payload === "object"
                        ? ((event.payload as { sessionKey?: string }).sessionKey ?? "")
                        : "";
                    return html`
                      <div class="list-item debug-run-log__event-item">
                        <div class="list-main">
                          <div class="list-title">${event.event}</div>
                          <div class="list-sub">
                            ${formatTimestamp(event.ts)}
                            ${sessionKey ? html`· <span class="mono">${sessionKey}</span>` : nothing}
                          </div>
                        </div>
                        <div class="list-meta debug-run-log__event-meta">
                          <pre class="code-block debug-run-log__event-payload">${formatEventPayload(
                            event.payload,
                          )}</pre>
                        </div>
                      </div>
                    `;
                  })}
                </div>
              `
        }
      </div>
    </section>
  `;
}
