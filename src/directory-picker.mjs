import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DIRECTORY_PROMPTS = {
  bgm: "选择背景音乐文件夹",
  video: "选择视频素材文件夹"
};

export function isDirectoryPickerCancellation(error) {
  const message = String(error?.stderr || error?.message || "");
  return error?.code === 1 && /User canceled|用户取消|\(-128\)/i.test(message);
}

export async function chooseMediaDirectory(type, options = {}) {
  const prompt = DIRECTORY_PROMPTS[type];
  if (!prompt) throw new Error("未知的素材库类型");

  const platform = options.platform || process.platform;
  if (platform !== "darwin") throw new Error("当前系统暂不支持文件夹选择器，请手动填写路径");

  const run = options.execFile || execFileAsync;
  try {
    const { stdout } = await run("/usr/bin/osascript", [
      "-e",
      `POSIX path of (choose folder with prompt "${prompt}")`
    ], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    const selected = String(stdout || "").trim();
    return selected
      ? { cancelled: false, path: path.resolve(selected) }
      : { cancelled: true, path: "" };
  } catch (error) {
    if (isDirectoryPickerCancellation(error)) return { cancelled: true, path: "" };
    const message = String(error?.stderr || error?.message || "未知错误").trim();
    throw new Error(`无法打开文件夹选择器：${message}`);
  }
}
