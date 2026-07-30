import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const EXTENSIONS = {
  bgm: new Set([".mp3", ".wav", ".flac", ".m4a", ".aac"]),
  video: new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"])
};

async function walk(root, current, extensions, files, depth = 0) {
  if (depth > 6 || files.length >= 300) return;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= 300 || entry.name.startsWith(".")) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, extensions, files, depth + 1);
      continue;
    }
    if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
    const info = await stat(full);
    files.push({
      name: entry.name,
      relativePath: path.relative(root, full),
      fullPath: full,
      size: info.size,
      updatedAt: info.mtime.toISOString()
    });
  }
}

export async function listMediaLibrary(config, type) {
  if (!EXTENSIONS[type]) throw new Error("未知的素材库类型");
  const root = String(type === "bgm" ? config.media.bgmRoot : config.media.videoRoot).trim();
  if (!root) return { type, root: "", exists: false, files: [] };
  const resolved = path.resolve(root);
  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) return { type, root: resolved, exists: false, files: [] };
  } catch {
    return { type, root: resolved, exists: false, files: [] };
  }
  const files = [];
  await walk(resolved, resolved, EXTENSIONS[type], files);
  files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { type, root: resolved, exists: true, files };
}
