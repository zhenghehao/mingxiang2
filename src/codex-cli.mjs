import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CODEX_MODELS = [
  { id: "gpt-5.6-sol", label: "5.6 Sol", description: "质量优先，适合复杂长文" },
  { id: "gpt-5.6-terra", label: "5.6 Terra", description: "质量与速度均衡" },
  { id: "gpt-5.6-luna", label: "5.6 Luna", description: "快速，适合重复和结构化任务" },
  { id: "gpt-5.5", label: "5.5", description: "上一代复杂任务模型" },
  { id: "gpt-5.4", label: "5.4", description: "日常通用模型" },
  { id: "gpt-5.4-mini", label: "5.4 Mini", description: "轻量快速模型" }
];

const DEFAULT_APP_CLI = "/Applications/ChatGPT.app/Contents/Resources/codex";

async function isExecutable(file) {
  if (!file) return false;
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathCodex() {
  try {
    const { stdout } = await execFileAsync("/bin/zsh", ["-lc", "command -v codex"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function resolveCodexCli(config = {}) {
  const configured = String(config?.textEngine?.codexCli?.path || "").trim();
  const candidates = [
    configured && configured !== "auto" ? configured : "",
    process.env.CODEX_CLI_PATH,
    DEFAULT_APP_CLI,
    await pathCodex()
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    if (await isExecutable(candidate)) return candidate;
  }
  return "";
}

async function command(executable, args, timeout = 10_000) {
  return execFileAsync(executable, args, {
    timeout,
    maxBuffer: 256 * 1024,
    env: { ...process.env, NO_COLOR: "1" }
  });
}

export async function inspectCodexCli(config = {}) {
  const executable = await resolveCodexCli(config);
  const settings = config?.textEngine?.codexCli || {};
  const model = String(settings.model || "gpt-5.6-sol");
  const reasoningEffort = String(settings.reasoningEffort || "high");
  if (!executable) {
    return {
      available: false,
      connected: false,
      path: "",
      version: "",
      authStatus: "未找到 Codex CLI",
      model,
      reasoningEffort,
      models: CODEX_MODELS
    };
  }

  let version = "";
  let authStatus = "";
  try {
    version = (await command(executable, ["--version"])).stdout.trim();
  } catch (error) {
    return {
      available: false,
      connected: false,
      path: executable,
      version: "",
      authStatus: error.message,
      model,
      reasoningEffort,
      models: CODEX_MODELS
    };
  }
  try {
    const result = await command(executable, ["login", "status"]);
    authStatus = `${result.stdout || ""}${result.stderr || ""}`.trim();
  } catch (error) {
    authStatus = `${error.stdout || ""}${error.stderr || ""}`.trim() || "尚未登录";
  }
  return {
    available: true,
    connected: /logged in/i.test(authStatus),
    path: executable,
    version,
    authStatus,
    model,
    reasoningEffort,
    models: CODEX_MODELS
  };
}

function buildPrompt(instructions, input) {
  return [
    "你正在执行眠屿本地工作台的一步文本任务。",
    "必须遵守下面的 Skill 与运行约定。只返回当前任务要求的最终内容，不要描述执行过程。",
    "\n# Skill 与运行约定\n",
    String(instructions || "").trim(),
    "\n# 本次输入\n",
    String(input || "").trim()
  ].join("\n");
}

function runCodexProcess(executable, args, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => `${current}${chunk}`.slice(-1_000_000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const detail = stderr.trim().split("\n").slice(-8).join("\n");
      reject(new Error(signal
        ? `Codex CLI 运行超时或被终止（${signal}）`
        : `Codex CLI 运行失败（退出码 ${code}）${detail ? `：${detail}` : ""}`));
    });
    child.stdin.end(prompt);
  });
}

export async function callCodexCliText(config, instructions, input, options = {}) {
  const status = await inspectCodexCli(config);
  if (!status.available) throw new Error("没有找到 Codex CLI，请先安装或填写 CLI 路径");
  if (!status.connected) throw new Error("Codex CLI 尚未登录，请先在终端运行 codex login");

  const settings = config?.textEngine?.codexCli || {};
  const model = String(options.model || settings.model || "gpt-5.6-sol");
  const reasoningEffort = String(options.reasoningEffort || settings.reasoningEffort || "high");
  const timeoutMs = Number(options.timeoutMs || settings.timeoutMs || 900_000);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "sleepflow-codex-"));
  const outputFile = path.join(tempDir, "last-message.txt");
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "-C", PROJECT_ROOT,
    "-s", "read-only",
    "-m", model,
    "-c", `model_reasoning_effort=\"${reasoningEffort}\"`,
    "-o", outputFile,
    "-"
  ];
  const started = Date.now();
  try {
    const processResult = await runCodexProcess(
      status.path,
      args,
      buildPrompt(instructions, input),
      timeoutMs
    );
    const text = (await readFile(outputFile, "utf8").catch(() => "")).trim();
    if (!text) {
      const detail = processResult.stderr.trim().split("\n").slice(-8).join("\n");
      throw new Error(`Codex CLI 已结束，但没有返回文本${detail ? `：${detail}` : ""}`);
    }
    return {
      text,
      engine: "codex-cli",
      model,
      reasoningEffort,
      elapsedMs: Date.now() - started,
      path: status.path,
      version: status.version
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
