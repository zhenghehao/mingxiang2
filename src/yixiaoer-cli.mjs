import { constants as fsConstants } from "node:fs";
import { access, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_CLI_PATHS = [
  "/Users/shareit/.hermes/node/lib/node_modules/@yixiaoermail/cli/bin-native/yxer",
  "/Users/shareit/.hermes/node/bin/yxer",
  "/opt/homebrew/bin/yxer",
  "/usr/local/bin/yxer"
];

async function isExecutable(file) {
  if (!file) return false;
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runProcess(executable, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => `${current}${chunk}`.slice(-2_000_000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = { code, signal, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0) return resolve(result);
      const payload = parseJson(result.stdout) || parseJson(result.stderr);
      const message = payload?.error?.message || result.stderr || result.stdout || "蚁小二 CLI 运行失败";
      const error = new Error(signal ? "蚁小二 CLI 运行超时" : message);
      error.code = payload?.error?.code || "YXER_COMMAND_FAILED";
      error.hint = payload?.error?.hint || "";
      error.payload = payload;
      reject(error);
    });
  });
}

function parseJson(value) {
  try {
    return JSON.parse(String(value || "").trim());
  } catch {
    return null;
  }
}

async function pathYxer() {
  return new Promise((resolve) => {
    const child = spawn("/bin/zsh", ["-lc", "command -v yxer"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => resolve(""));
    child.on("close", (code) => resolve(code === 0 ? stdout.trim() : ""));
  });
}

export async function resolveYixiaoerCli(config = {}) {
  const configured = String(config?.publishing?.cli?.path || "").trim();
  const candidates = [
    configured && configured !== "auto" ? configured : "",
    process.env.YXER_CLI_PATH,
    ...DEFAULT_CLI_PATHS,
    await pathYxer()
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    if (await isExecutable(candidate)) return candidate;
  }
  return "";
}

async function runJson(executable, args, timeoutMs) {
  const result = await runProcess(executable, args, timeoutMs);
  const payload = parseJson(result.stdout);
  if (!payload) throw new Error("蚁小二 CLI 返回了无法识别的结果");
  if (payload.ok === false) {
    const error = new Error(payload?.error?.message || "蚁小二 CLI 运行失败");
    error.code = payload?.error?.code || "YXER_COMMAND_FAILED";
    error.hint = payload?.error?.hint || "";
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function inspectYixiaoerCli(config = {}) {
  const executable = await resolveYixiaoerCli(config);
  if (!executable) {
    return {
      available: false,
      configured: false,
      connected: false,
      path: "",
      version: "",
      configPath: "",
      message: "没有找到蚁小二 CLI"
    };
  }

  let version = "";
  try {
    const versionResult = await runJson(executable, ["--version"], 10_000);
    version = String(versionResult?.data?.version || versionResult?.version || "");
  } catch (error) {
    return {
      available: false,
      configured: false,
      connected: false,
      path: executable,
      version: "",
      configPath: "",
      message: error.message
    };
  }

  let localConfig = {};
  try {
    localConfig = (await runJson(executable, ["config", "get"], 10_000)).data || {};
  } catch (error) {
    return {
      available: true,
      configured: false,
      connected: false,
      path: executable,
      version,
      configPath: "",
      message: error.message
    };
  }

  const configured = Boolean(localConfig.apiKeyPresent);
  if (!configured) {
    return {
      available: true,
      configured: false,
      connected: false,
      path: executable,
      version,
      configPath: String(localConfig.configPath || ""),
      apiUrl: String(localConfig.apiUrl || ""),
      localPublishClientId: String(localConfig.localPublishClientId || ""),
      message: "CLI 已安装，等待配置 API Key"
    };
  }

  try {
    await runJson(executable, ["doctor"], 30_000);
    return {
      available: true,
      configured: true,
      connected: true,
      path: executable,
      version,
      configPath: String(localConfig.configPath || ""),
      apiUrl: String(localConfig.apiUrl || ""),
      localPublishClientId: String(localConfig.localPublishClientId || ""),
      message: "蚁小二 CLI 已连接"
    };
  } catch (error) {
    return {
      available: true,
      configured: true,
      connected: false,
      path: executable,
      version,
      configPath: String(localConfig.configPath || ""),
      apiUrl: String(localConfig.apiUrl || ""),
      localPublishClientId: String(localConfig.localPublishClientId || ""),
      message: error.message,
      hint: error.hint || ""
    };
  }
}

async function protectCliConfig(configPath) {
  if (!configPath) return;
  await chmod(path.dirname(configPath), 0o700).catch(() => {});
  await chmod(configPath, 0o600).catch(() => {});
}

export async function configureYixiaoerApiKey(config, apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("请粘贴蚁小二 API Key");
  if (key.length > 4096) throw new Error("API Key 长度异常");
  const executable = await resolveYixiaoerCli(config);
  if (!executable) throw new Error("没有找到蚁小二 CLI，请先安装");
  await runJson(executable, ["config", "set-api-key", key], 30_000);
  const status = await inspectYixiaoerCli(config);
  await protectCliConfig(status.configPath);
  return status;
}

export async function listYixiaoerAccounts(config, platform = "") {
  const status = await inspectYixiaoerCli(config);
  if (!status.connected) throw new Error(status.message || "蚁小二 CLI 尚未连接");
  const args = ["accounts", "list"];
  const selectedPlatform = String(platform || "").trim();
  if (selectedPlatform) args.push(selectedPlatform);
  args.push("--all", "--json");
  const payload = await runJson(status.path, args, 60_000);
  return { ok: true, platform: selectedPlatform, data: payload.data ?? payload, raw: payload };
}
