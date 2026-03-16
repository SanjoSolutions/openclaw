import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { ensureSkillSnapshot } from "./session-updates.js";

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn(),
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  ensureSkillsWatcher: vi.fn(),
  getSkillsSnapshotVersion: vi.fn(() => 0),
}));

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    updateSessionStore: vi.fn(async () => {}),
  };
});

describe("ensureSkillSnapshot", () => {
  const originalFast = process.env.OPENCLAW_TEST_FAST;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENCLAW_TEST_FAST;
  });

  afterAll(() => {
    if (originalFast === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    process.env.OPENCLAW_TEST_FAST = originalFast;
  });

  it("refreshes legacy version 0 snapshots for existing sessions", async () => {
    const { buildWorkspaceSkillSnapshot } = await import("../../agents/skills.js");
    const { getSkillsSnapshotVersion } = await import("../../agents/skills/refresh.js");
    const { updateSessionStore } = await import("../../config/sessions.js");

    vi.mocked(getSkillsSnapshotVersion).mockReturnValue(0);
    vi.mocked(buildWorkspaceSkillSnapshot).mockReturnValue({
      prompt: "<available_skills><skill>gog</skill></available_skills>",
      skills: [{ name: "gog" }],
      version: 1,
    });

    const sessionStore = {
      "agent:main:main": {
        sessionId: "session-1",
        updatedAt: 0,
        systemSent: true,
        skillsSnapshot: {
          prompt: "<available_skills><skill>weather</skill></available_skills>",
          skills: [{ name: "weather" }],
          version: 0,
        },
      },
    };

    const result = await ensureSkillSnapshot({
      sessionEntry: sessionStore["agent:main:main"],
      sessionStore,
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
      sessionId: "session-1",
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/workspace",
      cfg: {} as OpenClawConfig,
    });

    expect(buildWorkspaceSkillSnapshot).toHaveBeenCalledOnce();
    expect(vi.mocked(buildWorkspaceSkillSnapshot).mock.calls[0]?.[1]).toMatchObject({
      snapshotVersion: 1,
    });
    expect(result.skillsSnapshot).toMatchObject({
      skills: [{ name: "gog" }],
      version: 1,
    });
    expect(sessionStore["agent:main:main"].skillsSnapshot).toMatchObject({
      skills: [{ name: "gog" }],
      version: 1,
    });
    expect(updateSessionStore).toHaveBeenCalledOnce();
  });
});
