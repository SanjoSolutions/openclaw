import { describe, expect, it } from "vitest";
import { buildSandboxSrtExecArgv, buildSandboxSrtRuntimeConfig, renderShellArgv } from "./srt.js";

describe("buildSandboxSrtRuntimeConfig", () => {
  it("adds workspace access and keeps network deny-by-default", () => {
    const config = buildSandboxSrtRuntimeConfig({
      sandbox: {
        workspaceDir: "/repo",
        agentWorkspaceDir: "/agent",
        workspaceAccess: "rw",
        docker: {
          image: "unused",
          containerPrefix: "unused",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: [],
          network: "none",
          capDrop: [],
          binds: ["/mnt/shared:/shared:ro", "/mnt/out:/out:rw"],
        },
        srt: {
          command: "srt",
          network: {
            allowedDomains: [],
            deniedDomains: [],
            allowUnixSockets: [],
            allowAllUnixSockets: false,
            allowLocalBinding: false,
            enableWeakerNestedSandbox: false,
          },
          filesystem: {
            denyRead: ["~/.ssh"],
            allowRead: ["docs"],
            allowWrite: ["build"],
            denyWrite: [".env"],
          },
        },
      },
    });

    expect(config.network.allowedDomains).toEqual([]);
    expect(config.filesystem.allowRead).toContain("/repo");
    expect(config.filesystem.allowRead).toContain("/agent");
    expect(config.filesystem.allowRead).toContain("/mnt/shared");
    expect(config.filesystem.allowWrite).toContain("/repo");
    expect(config.filesystem.allowWrite).toContain("/mnt/out");
    expect(config.filesystem.allowWrite).toContain("/repo/build");
    expect(config.filesystem.denyWrite).toContain("/repo/.env");
  });
});

describe("buildSandboxSrtExecArgv", () => {
  it("wraps shell execution through srt with a settings file", () => {
    const argv = buildSandboxSrtExecArgv({
      command: "echo hello",
      settingsPath: "/tmp/srt.json",
      shell: "/bin/sh",
      shellArgs: ["-c"],
      srtCommand: "srt",
    });

    expect(argv).toEqual(["srt", "--settings", "/tmp/srt.json", "/bin/sh", "-c", "echo hello"]);
    expect(renderShellArgv(argv)).toContain("srt");
    expect(renderShellArgv(argv)).toContain("--settings");
  });
});
