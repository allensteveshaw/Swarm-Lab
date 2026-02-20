import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

type ExecuteShellInput = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputKB?: number;
  workspaceRoot?: string;
};

type ExecuteShellSuccess = {
  ok: true;
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  shellMode: string;
};

type ExecuteShellFailure = {
  ok: false;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  cwd: string;
  shellMode: string;
  error: string;
};

type ExecuteShellResult = ExecuteShellSuccess | ExecuteShellFailure;

function getShellMode() {
  const mode = (process.env.AGENT_SHELL_MODE ?? "auto").toLowerCase();
  if (mode === "powershell" || mode === "pwsh") return "powershell";
  if (mode === "cmd") return "cmd";
  if (mode === "bash") return "bash";
  if (process.platform === "win32") return "powershell";
  return "bash";
}

function quoteForWindowsCommand(command: string) {
  return command.replace(/"/g, '\\"');
}

function getShellAndCommand(command: string): { shell: string; commandText: string; shellMode: string } {
  const shellMode = getShellMode();
  if (shellMode === "cmd") {
    return {
      shell: "cmd.exe",
      commandText: `/d /s /c "${quoteForWindowsCommand(command)}"`,
      shellMode,
    };
  }
  if (shellMode === "powershell") {
    return {
      shell: "powershell.exe",
      commandText: `-NoProfile -ExecutionPolicy Bypass -Command "${quoteForWindowsCommand(command)}"`,
      shellMode,
    };
  }
  return {
    shell: "/bin/bash",
    commandText: `-lc "${quoteForWindowsCommand(command)}"`,
    shellMode,
  };
}

function resolveCwd(workspaceRoot: string, requestedCwd: string | undefined) {
  const trimmed = (requestedCwd ?? "").trim();
  if (!trimmed) return path.resolve(workspaceRoot);
  const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(workspaceRoot, trimmed);
  const rootResolved = path.resolve(workspaceRoot);
  if (!resolved.startsWith(rootResolved)) {
    throw new Error(`cwd must be within workspace root: ${rootResolved}`);
  }
  return resolved;
}

export async function executeShellCommand(input: ExecuteShellInput): Promise<ExecuteShellResult> {
  const execAsync = promisify(exec);
  const workspaceRoot = input.workspaceRoot ?? process.env.AGENT_WORKDIR ?? process.cwd();
  const finalCwd = resolveCwd(workspaceRoot, input.cwd);
  const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : 120000;
  const maxOutputKB = Number(input.maxOutputKB) > 0 ? Number(input.maxOutputKB) : 1024;
  const maxBuffer = Math.max(64 * 1024, Math.floor(maxOutputKB * 1024));
  const shellSpec = getShellAndCommand(input.command);

  try {
    const { stdout, stderr } = await execAsync(shellSpec.commandText, {
      cwd: finalCwd,
      timeout: timeoutMs,
      maxBuffer,
      shell: shellSpec.shell,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr, exitCode: 0, cwd: finalCwd, shellMode: shellSpec.shellMode };
  } catch (err: any) {
    return {
      ok: false,
      stdout: err?.stdout ?? "",
      stderr: err?.stderr ?? "",
      exitCode: typeof err?.code === "number" ? err.code : null,
      signal: typeof err?.signal === "string" ? err.signal : null,
      cwd: finalCwd,
      shellMode: shellSpec.shellMode,
      error: String(err?.message ?? err),
    };
  }
}
