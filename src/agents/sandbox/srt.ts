import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveUserPath } from "../../utils.js";
import { loadWorkspaceSkillEntries } from "../skills.js";
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
  seccomp?: {
    applyPath: string;
    bpfPath: string;
  };
};

type SandboxSrtSeccompPaths = {
  applyPath: string;
  bpfPath: string;
};

type SandboxSrtSkillArtifacts = {
  shellPath?: string;
  env?: Record<string, string>;
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
  seccomp?: SandboxSrtSeccompPaths | null;
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
    ...(params.seccomp
      ? {
          seccomp: {
            applyPath: params.seccomp.applyPath,
            bpfPath: params.seccomp.bpfPath,
          },
        }
      : {}),
  };
}

export async function createSandboxSrtSettingsFile(params: { sandbox: SandboxSrtContext }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-srt-"));
  const settingsPath = path.join(dir, `${randomUUID()}.json`);
  const seccomp = await stageSandboxSrtSeccompAssets({
    dir,
    srtCommand: params.sandbox.srt.command,
  });
  const skillArtifacts = await stageSandboxSkillArtifacts({
    dir,
    workspaceDir: params.sandbox.workspaceDir,
  });
  const config = buildSandboxSrtRuntimeConfig({
    ...params,
    seccomp,
  });
  await fs.writeFile(settingsPath, JSON.stringify(config, null, 2), "utf8");
  return {
    settingsPath,
    shellPath: skillArtifacts.shellPath,
    env: skillArtifacts.env,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

async function stageSandboxSrtSeccompAssets(params: {
  dir: string;
  srtCommand: string;
}): Promise<SandboxSrtSeccompPaths | null> {
  const sourcePaths = await resolveSandboxSrtSeccompPaths(params.srtCommand);
  if (!sourcePaths) {
    return null;
  }
  const archDir = path.dirname(sourcePaths.applyPath);
  const stagedDir = path.join(params.dir, "seccomp", path.basename(archDir));
  await fs.mkdir(stagedDir, { recursive: true });
  const stagedApplyPath = path.join(stagedDir, "apply-seccomp");
  const stagedBpfPath = path.join(stagedDir, "unix-block.bpf");
  await fs.copyFile(sourcePaths.applyPath, stagedApplyPath);
  await fs.copyFile(sourcePaths.bpfPath, stagedBpfPath);
  await fs.chmod(stagedApplyPath, 0o755);
  return {
    applyPath: stagedApplyPath,
    bpfPath: stagedBpfPath,
  };
}

async function stageSandboxSkillArtifacts(params: {
  dir: string;
  workspaceDir: string;
}): Promise<SandboxSrtSkillArtifacts> {
  const homeDir = path.resolve(os.homedir());
  const entries = loadWorkspaceSkillEntries(params.workspaceDir);
  const requiredBins = collectSandboxSkillBins(entries);
  const stagedBinDir = path.join(params.dir, "bin");
  let stagedAny = false;
  for (const bin of requiredBins) {
    const resolvedBinPath = await resolveBinaryPathFromPath(bin);
    if (!resolvedBinPath) {
      continue;
    }
    const normalized = path.resolve(resolvedBinPath);
    if (!isPathInsideRoot(normalized, homeDir)) {
      continue;
    }
    await fs.mkdir(stagedBinDir, { recursive: true });
    const stagedPath = path.join(stagedBinDir, bin);
    await fs.copyFile(normalized, stagedPath);
    await fs.chmod(stagedPath, 0o755);
    stagedAny = true;
  }
  const gogEnv = requiredBins.includes("gog")
    ? await stageSandboxGogAuth({
        dir: params.dir,
        homeDir,
      })
    : undefined;
  return {
    ...(stagedAny ? { shellPath: stagedBinDir } : {}),
    ...(gogEnv ? { env: gogEnv } : {}),
  };
}

function collectSandboxSkillBins(
  entries: Array<{
    metadata?: {
      requires?: { bins?: string[]; anyBins?: string[] };
      install?: Array<{ bins?: string[] }>;
    };
  }>,
) {
  const bins = new Set<string>();
  for (const entry of entries) {
    for (const bin of entry.metadata?.requires?.bins ?? []) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const bin of entry.metadata?.requires?.anyBins ?? []) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const spec of entry.metadata?.install ?? []) {
      for (const bin of spec.bins ?? []) {
        const trimmed = bin.trim();
        if (trimmed) {
          bins.add(trimmed);
        }
      }
    }
  }
  return [...bins];
}

async function resolveSandboxSrtSeccompPaths(
  srtCommand: string,
): Promise<SandboxSrtSeccompPaths | null> {
  const arch = resolveSandboxSrtVendorArch();
  if (!arch) {
    return null;
  }
  const commandPath = await resolveSandboxSrtCommandPath(srtCommand);
  if (!commandPath) {
    return null;
  }

  const candidateRoots = collectSandboxSrtCandidateRoots(commandPath);
  for (const root of candidateRoots) {
    const applyPath = path.join(root, "vendor", "seccomp", arch, "apply-seccomp");
    const bpfPath = path.join(root, "vendor", "seccomp", arch, "unix-block.bpf");
    if ((await pathExists(applyPath)) && (await pathExists(bpfPath))) {
      return { applyPath, bpfPath };
    }
  }
  return null;
}

function resolveSandboxSrtVendorArch() {
  switch (process.arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    default:
      return null;
  }
}

async function resolveSandboxSrtCommandPath(command: string): Promise<string | null> {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }
  if (/[\\/]/.test(trimmed) || trimmed.startsWith(".")) {
    const resolved = trimmed.startsWith("~") ? resolveUserPath(trimmed) : path.resolve(trimmed);
    return (await pathExists(resolved)) ? fs.realpath(resolved).catch(() => resolved) : null;
  }
  const searchPaths = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of searchPaths) {
    const candidate = path.join(entry, trimmed);
    if (await pathExists(candidate)) {
      return fs.realpath(candidate).catch(() => candidate);
    }
  }
  return null;
}

async function resolveBinaryPathFromPath(command: string): Promise<string | null> {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }
  if (/[\\/]/.test(trimmed) || trimmed.startsWith(".")) {
    const resolved = trimmed.startsWith("~") ? resolveUserPath(trimmed) : path.resolve(trimmed);
    return (await pathExists(resolved)) ? fs.realpath(resolved).catch(() => resolved) : null;
  }
  const searchPaths = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of searchPaths) {
    const candidate = path.join(entry, trimmed);
    if (await pathExists(candidate)) {
      return fs.realpath(candidate).catch(() => candidate);
    }
  }
  return null;
}

async function stageSandboxGogAuth(params: {
  dir: string;
  homeDir: string;
}): Promise<Record<string, string> | undefined> {
  const configSourceDir = path.join(params.homeDir, ".config", "gogcli");
  const keyringSourcePath = path.join(
    params.homeDir,
    ".local",
    "share",
    "keyrings",
    "gogcli.keyring",
  );
  if (!(await pathExists(configSourceDir)) && !(await pathExists(keyringSourcePath))) {
    return undefined;
  }

  const configHome = path.join(params.dir, "config");
  const dataHome = path.join(params.dir, "share");
  if (await pathExists(configSourceDir)) {
    await fs.mkdir(configHome, { recursive: true });
    await copyPath(configSourceDir, path.join(configHome, "gogcli"));
  }
  if (await pathExists(keyringSourcePath)) {
    const keyringDir = path.join(dataHome, "keyrings");
    await fs.mkdir(keyringDir, { recursive: true });
    await fs.copyFile(keyringSourcePath, path.join(keyringDir, "gogcli.keyring"));
  }
  return {
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
  };
}

function collectSandboxSrtCandidateRoots(commandPath: string) {
  const roots = new Set<string>();
  let current = path.dirname(commandPath);
  for (let depth = 0; depth < 8; depth += 1) {
    roots.add(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return roots;
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyPath(sourcePath: string, targetPath: string) {
  const stats = await fs.stat(sourcePath);
  if (stats.isDirectory()) {
    await fs.mkdir(targetPath, { recursive: true });
    for (const entry of await fs.readdir(sourcePath, { withFileTypes: true })) {
      await copyPath(path.join(sourcePath, entry.name), path.join(targetPath, entry.name));
    }
    return;
  }
  await fs.copyFile(sourcePath, targetPath);
}

function isPathInsideRoot(candidatePath: string, rootPath: string) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
