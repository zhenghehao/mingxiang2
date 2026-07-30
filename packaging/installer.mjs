import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(process.argv[2] || ".");
const home = os.homedir();
const applicationsDir = path.join(home, "Applications");
const targetApp = path.join(applicationsDir, "眠屿工作台.app");
const sourceApp = path.join(sourceRoot, "眠屿工作台.app");
const dataDir = path.join(home, "Library", "Application Support", "眠屿工作台");
const outputDir = path.join(home, "Desktop", "output");
const credentialsDir = path.join(sourceRoot, "credentials");
const secretAccounts = [
  ["minimax-subscription-key", path.join(credentialsDir, ".minimax-subscription-key")],
  ["minimax-api-key", path.join(credentialsDir, ".minimax-api-key")],
  ["text-provider-api-key", path.join(credentialsDir, ".text-provider-api-key")]
];

function skillId(file) {
  return createHash("sha256").update(file).digest("hex").slice(0, 16);
}

function stamp() {
  const now = new Date();
  return now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

async function show(message) {
  await execFileAsync("/usr/bin/osascript", ["-e", `display dialog ${JSON.stringify(message)} buttons {"好"} default button "好"`]);
}

await mkdir(applicationsDir, { recursive: true });
await mkdir(dataDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

try {
  await rename(targetApp, path.join(applicationsDir, `眠屿工作台-旧版-${stamp()}.app`));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

await cp(sourceApp, targetApp, { recursive: true, force: true, preserveTimestamps: true });

const appResources = path.join(targetApp, "Contents", "Resources", "app", "resources");
const activeSkills = {
  topic: path.join(appResources, "skills", "01-topic", "SKILL.md"),
  script: path.join(appResources, "skills", "02-script", "SKILL.md"),
  ttsOptimizer: path.join(appResources, "skills", "03-minimax-tts", "SKILL.md"),
  copywriter: path.join(appResources, "skills", "04-publisher-copywriter", "SKILL.md")
};

const configTemplate = path.join(targetApp, "Contents", "Resources", "app", "data", "config.json");
const config = JSON.parse(await readFile(configTemplate, "utf8"));
config.app.outputRoot = outputDir;
config.app.runRoot = path.join(dataDir, "work", "runs");
config.skillRoots = Object.values(activeSkills).map((file) => path.dirname(file));
config.slots = Object.fromEntries(Object.entries(activeSkills).map(([slot, file]) => [slot, skillId(file)]));
config.media.bgmRoot = path.join(appResources, "media", "bgm");
config.media.videoRoot = path.join(appResources, "media", "video");
config.textEngine.codexCli.path = "auto";
config.publishing.cli.path = "auto";
const bundledYixer = path.join(targetApp, "Contents", "Resources", "runtime", "yxer");
try {
  await execFileAsync("/usr/bin/chmod", ["755", bundledYixer]);
  config.publishing.cli.path = bundledYixer;
} catch {}
config.agnes.enabled = true;
config.agnes.embedded = true;
config.agnes.baseUrl = "http://127.0.0.1:8899";
config.agnes.projectRoot = path.join(targetApp, "Contents", "Resources", "app", "agnes");
await writeFile(path.join(dataDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

for (const executable of [
  path.join(targetApp, "Contents", "Resources", "runtime", "node"),
  path.join(targetApp, "Contents", "Resources", "app", "node_modules", "ffmpeg-static", "ffmpeg"),
  path.join(targetApp, "Contents", "Resources", "app", "node_modules", "ffprobe-static", "bin", "darwin", "x64", "ffprobe"),
  path.join(targetApp, "Contents", "Resources", "app", "extensions", "draft-publisher", "runtime", "python", "bin", "python3.11")
]) {
  await execFileAsync("/bin/chmod", ["755", executable]);
}

let importedSecrets = 0;
for (const [account, file] of secretAccounts) {
  try {
    const value = (await readFile(file, "utf8")).trim();
    if (!value) continue;
    await execFileAsync("/usr/bin/security", [
      "add-generic-password", "-U",
      "-s", "com.shareit.sleepflow-studio",
      "-a", account,
      "-w", value
    ]);
    importedSecrets += 1;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
async function copyCredentialIfAbsent(name, destination) {
  const source = path.join(credentialsDir, name);
  try {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    await execFileAsync("/usr/bin/chmod", ["600", destination]);
  } catch (error) {
    if (!(["ENOENT", "EEXIST"].includes(error?.code))) throw error;
  }
}
await copyCredentialIfAbsent("config.json", path.join(home, ".yxer", "config.json"));
await copyCredentialIfAbsent("auth.json", path.join(home, ".codex", "auth.json"));
await copyCredentialIfAbsent("config.toml", path.join(home, ".codex", "config.toml"));
await copyCredentialIfAbsent("hermes.env", path.join(home, ".hermes", ".env"));
await copyCredentialIfAbsent("gemini.env", path.join(home, ".gemini", ".env"));
await execFileAsync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", targetApp]).catch(() => {});
await execFileAsync("/usr/bin/open", [targetApp]);
const secretMessage = importedSecrets
  ? `已安全导入 ${importedSecrets} 个服务密钥到这台 Mac 的钥匙串。`
  : "未读取到可导入的钥匙串密钥；包内其他 API、Codex 与蚁小二配置仍已保留。";
await show(`安装完成。\n\n眠屿、Agnes 和七平台草稿服务已合并。\n应用位置：${applicationsDir}\n每日成品：${outputDir}\n${secretMessage}\n\n第一次使用请在“平台草稿”中检查七个平台登录状态。`);

// 密钥导入系统钥匙串；蚁小二与 Codex 配置仅在目标电脑尚无同名文件时复制，避免覆盖已有登录状态。
