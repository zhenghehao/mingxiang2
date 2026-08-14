/**
 * 成品目录的列举与删除。
 *
 * 成品的层级固定是 `<outputRoot>/<日期>/<标题>/`，一集就是最里面那一层。
 *
 * 删除是**不可逆**的，而且删的是用户跑了几分钟、花了真金白银才出来的东西，
 * 所以路径校验写在这里、配了测试，而不是散在路由里随手 `rm -rf`。
 * 校验的原则是白名单式的「必须正好是那一层」，不是黑名单式的「不能含 ..」——
 * 后者永远列不全（`..`、软链、URL 编码、大小写不敏感的文件系统…），
 * 而前者只要有一条对不上就拒绝。
 */

import { readdir, rm, stat, realpath } from "node:fs/promises";
import path from "node:path";

/** 一集里这些扩展名算「占地方的媒体」，用来告诉用户删掉能省多少。 */
const MEDIA = new Set([".mp3", ".mp4", ".wav", ".m4a", ".mov", ".png", ".jpg", ".jpeg"]);

async function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  let media = 0;
  const walk = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile()) continue;
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      bytes += info.size;
      files += 1;
      if (MEDIA.has(path.extname(entry.name).toLowerCase())) media += info.size;
    }
  };
  await walk(dir);
  return { bytes, files, mediaBytes: media };
}

/**
 * 列出所有成品：`<outputRoot>/<日期>/<标题>`。
 *
 * 日期那一层里可能混着别的东西（比如 playwright 那种调试目录），
 * 所以只认「里面还有子目录」的那种，并且返回的 relPath 一律用 / 分隔，
 * 前端不必关心平台差异。
 */
export async function listOutputRuns(outputRoot) {
  const root = path.resolve(outputRoot);
  const runs = [];
  let dates;
  try {
    dates = await readdir(root, { withFileTypes: true });
  } catch {
    return runs;
  }
  for (const date of dates) {
    if (!date.isDirectory()) continue;
    const dateDir = path.join(root, date.name);
    let titles;
    try {
      titles = await readdir(dateDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const title of titles) {
      if (!title.isDirectory()) continue;
      const full = path.join(dateDir, title.name);
      const size = await dirSize(full);
      const info = await stat(full).catch(() => null);
      runs.push({
        date: date.name,
        title: title.name,
        relPath: `${date.name}/${title.name}`,
        ...size,
        updatedAt: info ? info.mtime.toISOString() : ""
      });
    }
  }
  // 新的排前面：要清理的多半是旧的，但先看到最近的才好判断哪些还要留
  return runs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/**
 * 把 relPath 解析成可以安全删除的绝对路径，任何一条对不上就抛错。
 *
 * 单独导出是因为「能不能删」这个判断本身才是要测的东西 ——
 * 真去删一遍再看结果，测试就得准备一堆真文件，而且测错了代价是删掉真东西。
 */
export function resolveDeletableRun(outputRoot, relPath) {
  const root = path.resolve(outputRoot);
  const raw = String(relPath ?? "").trim();
  if (!raw) throw new Error("没有指定要删除的成品");
  // 绝对路径直接拒。不拒的话 "/etc/passwd" 会被下面的 filter 抹掉开头那个空段，
  // 变成相对的 "etc/passwd"，最后解析成 output/etc/passwd —— 删不到 /etc，
  // 安全上没破，但**调用方明明传错了却被静默改写**，这种问题最难查。
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`要的是相对 output 的「日期/标题」，不是绝对路径：${raw}`);
  }
  // 统一分隔符后再拆，Windows 风格的反斜杠不能绕过下面的段数检查
  const parts = raw.replace(/\\/g, "/").split("/").filter((p) => p !== "");
  if (parts.length !== 2) {
    throw new Error(`只能删除「日期/标题」这一层，收到的是「${raw}」`);
  }
  if (parts.some((p) => p === "." || p === "..")) {
    throw new Error("路径里不允许出现 . 或 ..");
  }
  const full = path.resolve(root, parts[0], parts[1]);
  // 再核一次绝对路径的形状：拼出来的必须正好是 root 下面两层，
  // 既防拼接被绕过，也防有人直接把绝对路径塞进 relPath
  if (path.dirname(path.dirname(full)) !== root) {
    throw new Error("目标不在 output 目录内，拒绝删除");
  }
  return full;
}

/**
 * 删掉一集。
 *
 * 先 realpath 再核一次：软链指向 output 之外时，前面的字符串校验会通过
 * （路径长得没问题），但真删下去毁的是别处的文件。这一步必须在真删之前。
 */
export async function deleteOutputRun(outputRoot, relPath) {
  const root = path.resolve(outputRoot);
  const full = resolveDeletableRun(root, relPath);
  const info = await stat(full).catch(() => null);
  if (!info) throw new Error(`成品不存在或已经删过了：${relPath}`);
  if (!info.isDirectory()) throw new Error("目标不是目录，拒绝删除");
  const realRoot = await realpath(root);
  const real = await realpath(full);
  if (path.dirname(path.dirname(real)) !== realRoot) {
    throw new Error("目标（或其软链指向）不在 output 目录内，拒绝删除");
  }
  const size = await dirSize(full);
  await rm(full, { recursive: true, force: true });
  return { relPath, deletedBytes: size.bytes, deletedFiles: size.files };
}
