import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveUserPath } from "../../utils.js";
import { parseSandboxBindMount } from "./fs-paths.js";
import type { SandboxContext, SandboxSrtConfig } from "./types.js";

type SandboxSrtContext = Pick<
  SandboxContext,
  "workspaceDir" | "agentWorkspaceDir" | "workspaceAccess" | "docker"
> & {
  srt: SandboxSrtConfig;
};

type SandboxRuntimeConfigFile = {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowUnixSockets?: string[];
    allowAllUnixSockets?: boolean;
    allowLocalBinding?: boolean;
    enableWeakerNestedSandbox?: boolean;
  };
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
    mandatoryDenySearchDepth?: number;
  };
};

function dedupePaths(values: string[]) {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    deduped.push(trimmed);
  }
  return deduped;
}

function resolveSrtPath(baseDir: string, input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("~") || path.isAbsolute(trimmed)) {
    return resolveUserPath(trimmed);
  }
  return path.resolve(baseDir, trimmed);
}

function shellEscapeSingleArg(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderShellArgv(argv: string[]) {
  return argv.map((arg) => shellEscapeSingleArg(arg)).join(" ");
}

export function buildSandboxSrtRuntimeConfig(params: {
  sandbox: SandboxSrtContext;
}): SandboxRuntimeConfigFile {
  const workspaceRoots = [path.resolve(params.sandbox.workspaceDir)];
  if (
    path.resolve(params.sandbox.agentWorkspaceDir) !== path.resolve(params.sandbox.workspaceDir)
  ) {
    workspaceRoots.push(path.resolve(params.sandbox.agentWorkspaceDir));
  }

  const readableBindRoots: string[] = [];
  const writableBindRoots: string[] = [];
  for (const spec of params.sandbox.docker.binds ?? []) {
    const parsed = parseSandboxBindMount(spec);
    if (!parsed) {
      continue;
    }
    readableBindRoots.push(parsed.hostRoot);
    if (parsed.writable) {
      writableBindRoots.push(parsed.hostRoot);
    }
  }

  const writableRoots =
    params.sandbox.workspaceAccess === "rw"
      ? [...workspaceRoots, ...writableBindRoots]
      : [...writableBindRoots];

  const tempDirs = dedupePaths(
    [os.tmpdir(), "/tmp", "/var/tmp"].map((entry) => path.resolve(entry)),
  );
  const allowRead = dedupePaths([
    ...workspaceRoots,
    ...readableBindRoots,
    ...params.sandbox.srt.filesystem.allowRead.map((entry) =>
      resolveSrtPath(params.sandbox.workspaceDir, entry),
    ),
  ]);
  const allowWrite = dedupePaths([
    ...tempDirs,
    ...writableRoots,
    ...params.sandbox.srt.filesystem.allowWrite.map((entry) =>
      resolveSrtPath(params.sandbox.workspaceDir, entry),
    ),
  ]);
  const denyRead = dedupePaths([
    path.resolve(os.homedir()),
    ...params.sandbox.srt.filesystem.denyRead.map((entry) =>
      resolveSrtPath(params.sandbox.workspaceDir, entry),
    ),
  ]);
  const denyWrite = dedupePaths(
    params.sandbox.srt.filesystem.denyWrite.map((entry) =>
      resolveSrtPath(params.sandbox.workspaceDir, entry),
    ),
  );

  return {
    network: {
      allowedDomains: [...params.sandbox.srt.network.allowedDomains],
      deniedDomains: [...params.sandbox.srt.network.deniedDomains],
      ...(params.sandbox.srt.network.allowUnixSockets.length > 0
        ? { allowUnixSockets: [...params.sandbox.srt.network.allowUnixSockets] }
        : {}),
      ...(params.sandbox.srt.network.allowAllUnixSockets ? { allowAllUnixSockets: true } : {}),
      ...(params.sandbox.srt.network.allowLocalBinding ? { allowLocalBinding: true } : {}),
      ...(params.sandbox.srt.network.enableWeakerNestedSandbox
        ? { enableWeakerNestedSandbox: true }
        : {}),
    },
    filesystem: {
      denyRead,
      allowRead,
      allowWrite,
      denyWrite,
      ...(typeof params.sandbox.srt.filesystem.mandatoryDenySearchDepth === "number"
        ? { mandatoryDenySearchDepth: params.sandbox.srt.filesystem.mandatoryDenySearchDepth }
        : {}),
    },
  };
}

export async function createSandboxSrtSettingsFile(params: { sandbox: SandboxSrtContext }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-srt-"));
  const settingsPath = path.join(dir, `${randomUUID()}.json`);
  const config = buildSandboxSrtRuntimeConfig(params);
  await fs.writeFile(settingsPath, JSON.stringify(config, null, 2), "utf8");
  return {
    settingsPath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export function buildSandboxSrtExecArgv(params: {
  command: string;
  settingsPath: string;
  shell: string;
  shellArgs: string[];
  srtCommand: string;
}) {
  return [
    params.srtCommand,
    "--settings",
    params.settingsPath,
    params.shell,
    ...params.shellArgs,
    params.command,
  ];
}
