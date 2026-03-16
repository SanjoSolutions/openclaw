import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSandboxSrtExecArgv,
  buildSandboxSrtRuntimeConfig,
  createSandboxSrtSettingsFile,
  renderShellArgv,
} from "./srt.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalPath = process.env.PATH;

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

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

describe("createSandboxSrtSettingsFile", () => {
  it("stages seccomp assets alongside the generated settings file", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-srt-test-"));
    tempDirs.push(tempRoot);
    const packageRoot = path.join(
      tempRoot,
      "lib",
      "node_modules",
      "@anthropic-ai",
      "sandbox-runtime",
    );
    const distDir = path.join(packageRoot, "dist");
    const vendorDir = path.join(
      packageRoot,
      "vendor",
      "seccomp",
      process.arch === "arm64" ? "arm64" : "x64",
    );
    const binDir = path.join(tempRoot, "bin");
    const commandPath = path.join(binDir, "srt");
    await fs.mkdir(distDir, { recursive: true });
    await fs.mkdir(vendorDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(distDir, "cli.js"), "// fake srt cli\n", "utf8");
    await fs.writeFile(path.join(vendorDir, "apply-seccomp"), "#!/bin/sh\nexit 0\n", "utf8");
    await fs.writeFile(path.join(vendorDir, "unix-block.bpf"), "fake-bpf\n", "utf8");
    await fs.chmod(path.join(vendorDir, "apply-seccomp"), 0o755);
    await fs.symlink(
      path.join("..", "lib", "node_modules", "@anthropic-ai", "sandbox-runtime", "dist", "cli.js"),
      commandPath,
    );

    const result = await createSandboxSrtSettingsFile({
      sandbox: {
        workspaceDir: "/repo",
        agentWorkspaceDir: "/repo",
        workspaceAccess: "rw",
        docker: {
          image: "unused",
          containerPrefix: "unused",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: [],
          network: "none",
          capDrop: [],
        },
        srt: {
          command: commandPath,
          network: {
            allowedDomains: [],
            deniedDomains: [],
            allowUnixSockets: [],
            allowAllUnixSockets: false,
            allowLocalBinding: false,
            enableWeakerNestedSandbox: false,
          },
          filesystem: {
            denyRead: [],
            allowRead: [],
            allowWrite: [],
            denyWrite: [],
          },
        },
      },
    });

    const raw = await fs.readFile(result.settingsPath, "utf8");
    const settings = JSON.parse(raw) as {
      seccomp?: {
        applyPath?: string;
        bpfPath?: string;
      };
    };

    expect(settings.seccomp?.applyPath).toMatch(/openclaw-srt-.*\/seccomp\/.*\/apply-seccomp$/);
    expect(settings.seccomp?.bpfPath).toMatch(/openclaw-srt-.*\/seccomp\/.*\/unix-block\.bpf$/);
    await expect(fs.readFile(settings.seccomp!.applyPath!, "utf8")).resolves.toContain("exit 0");
    await expect(fs.readFile(settings.seccomp!.bpfPath!, "utf8")).resolves.toContain("fake-bpf");

    await result.cleanup();
  });

  it("stages home-directory skill binaries into a temp bin dir", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-srt-skill-bin-"));
    tempDirs.push(tempRoot);
    const homeDir = path.join(tempRoot, "home");
    const workspaceDir = path.join(homeDir, "workspace");
    const skillDir = path.join(workspaceDir, "skills", "gog");
    const localBinDir = path.join(homeDir, ".local", "bin");
    const gogPath = path.join(localBinDir, "gog");
    process.env.HOME = homeDir;
    process.env.PATH = [localBinDir, "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter);

    await fs.mkdir(skillDir, { recursive: true });
    await fs.mkdir(localBinDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: gog
description: Google Workspace CLI
metadata:
  {"openclaw":{"requires":{"bins":["gog"]}}}
---
`,
      "utf8",
    );
    await fs.writeFile(gogPath, "#!/bin/sh\necho gog\n", "utf8");
    await fs.chmod(gogPath, 0o755);

    const result = await createSandboxSrtSettingsFile({
      sandbox: {
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        docker: {
          image: "unused",
          containerPrefix: "unused",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: [],
          network: "none",
          capDrop: [],
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
            denyRead: [],
            allowRead: [],
            allowWrite: [],
            denyWrite: [],
          },
        },
      },
    });

    expect(result.shellPath).toMatch(/openclaw-srt-.*\/bin$/);
    await expect(fs.readFile(path.join(result.shellPath!, "gog"), "utf8")).resolves.toContain(
      "echo gog",
    );

    await result.cleanup();
  });

  it("stages gog auth into sandbox XDG dirs", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-srt-gog-auth-"));
    tempDirs.push(tempRoot);
    const homeDir = path.join(tempRoot, "home");
    const workspaceDir = path.join(homeDir, "workspace");
    const skillDir = path.join(workspaceDir, "skills", "gog");
    const configDir = path.join(homeDir, ".config", "gogcli");
    const keyringDir = path.join(homeDir, ".local", "share", "keyrings");
    process.env.HOME = homeDir;
    process.env.PATH = ["/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter);

    await fs.mkdir(skillDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(keyringDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: gog
description: Google Workspace CLI
metadata:
  {"openclaw":{"requires":{"bins":["gog"]}}}
---
`,
      "utf8",
    );
    await fs.writeFile(path.join(configDir, "credentials.json"), '{"ok":true}\n', "utf8");
    await fs.writeFile(path.join(keyringDir, "gogcli.keyring"), "secret\n", "utf8");

    const result = await createSandboxSrtSettingsFile({
      sandbox: {
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        docker: {
          image: "unused",
          containerPrefix: "unused",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: [],
          network: "none",
          capDrop: [],
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
            denyRead: [],
            allowRead: [],
            allowWrite: [],
            denyWrite: [],
          },
        },
      },
    });

    expect(result.env?.XDG_CONFIG_HOME).toMatch(/openclaw-srt-.*\/config$/);
    expect(result.env?.XDG_DATA_HOME).toMatch(/openclaw-srt-.*\/share$/);
    const { XDG_CONFIG_HOME, XDG_DATA_HOME } = result.env!;
    await expect(
      fs.readFile(path.join(XDG_CONFIG_HOME, "gogcli", "credentials.json"), "utf8"),
    ).resolves.toContain('"ok":true');
    await expect(
      fs.readFile(path.join(XDG_DATA_HOME, "keyrings", "gogcli.keyring"), "utf8"),
    ).resolves.toContain("secret");

    await result.cleanup();
  });
});
