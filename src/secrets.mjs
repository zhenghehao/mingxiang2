import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SECURITY = "/usr/bin/security";
const SERVICE = "com.shareit.sleepflow-studio";
const MINIMAX_ACCOUNTS = {
  api: "minimax-api-key",
  subscription: "minimax-subscription-key"
};
const TEXT_PROVIDER_ACCOUNT = "text-provider-api-key";

async function security(args) {
  return execFileAsync(SECURITY, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
}

function minimaxAccount(mode) {
  return mode === "subscription" ? MINIMAX_ACCOUNTS.subscription : MINIMAX_ACCOUNTS.api;
}

export async function readMinimaxKey(mode = "api") {
  try {
    const { stdout } = await security([
      "find-generic-password",
      "-s", SERVICE,
      "-a", minimaxAccount(mode),
      "-w"
    ]);
    return stdout.trim();
  } catch (error) {
    if (error?.code === 44) return "";
    const message = String(error?.stderr || error?.message || "");
    if (/could not be found/i.test(message)) return "";
    throw new Error(`无法读取 macOS 钥匙串：${message.trim() || "未知错误"}`);
  }
}

export async function writeMinimaxKey(value, mode = "api") {
  const key = String(value || "").trim();
  if (key.length < 10) throw new Error("API Key 看起来过短，请检查后重试");
  await security([
    "add-generic-password",
    "-U",
    "-s", SERVICE,
    "-a", minimaxAccount(mode),
    "-w", key
  ]);
}

export async function deleteMinimaxKey(mode = "api") {
  try {
    await security([
      "delete-generic-password",
      "-s", SERVICE,
      "-a", minimaxAccount(mode)
    ]);
  } catch (error) {
    if (error?.code === 44) return;
    const message = String(error?.stderr || error?.message || "");
    if (/could not be found/i.test(message)) return;
    throw new Error(`无法删除 macOS 钥匙串密钥：${message.trim() || "未知错误"}`);
  }
}

export async function minimaxKeyStatus(mode = "api") {
  return { configured: Boolean(await readMinimaxKey(mode)), mode: mode === "subscription" ? "subscription" : "api" };
}

export async function readTextProviderKey() {
  try {
    const { stdout } = await security([
      "find-generic-password",
      "-s", SERVICE,
      "-a", TEXT_PROVIDER_ACCOUNT,
      "-w"
    ]);
    return stdout.trim();
  } catch (error) {
    if (error?.code === 44) return "";
    const message = String(error?.stderr || error?.message || "");
    if (/could not be found/i.test(message)) return "";
    throw new Error(`无法读取 macOS 钥匙串：${message.trim() || "未知错误"}`);
  }
}

export async function writeTextProviderKey(value) {
  const key = String(value || "").trim();
  if (key.length < 10) throw new Error("API Key 看起来过短，请检查后重试");
  await security([
    "add-generic-password",
    "-U",
    "-s", SERVICE,
    "-a", TEXT_PROVIDER_ACCOUNT,
    "-w", key
  ]);
}

export async function deleteTextProviderKey() {
  try {
    await security([
      "delete-generic-password",
      "-s", SERVICE,
      "-a", TEXT_PROVIDER_ACCOUNT
    ]);
  } catch (error) {
    if (error?.code === 44) return;
    const message = String(error?.stderr || error?.message || "");
    if (/could not be found/i.test(message)) return;
    throw new Error(`无法删除 macOS 钥匙串密钥：${message.trim() || "未知错误"}`);
  }
}

export async function textProviderKeyStatus() {
  return { configured: Boolean(await readTextProviderKey()) };
}
