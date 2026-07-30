import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

function parseFrontmatter(raw) {
  if (!raw.startsWith("---\n")) return {};
  const end = raw.indexOf("\n---", 4);
  if (end < 0) return {};
  const frontmatter = raw.slice(4, end);
  const result = {};
  let foldedKey = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) {
      const value = match[2].trim();
      foldedKey = /^[>|][+-]?$/.test(value) ? match[1] : null;
      result[match[1]] = foldedKey ? "" : value.replace(/^['"]|['"]$/g, "");
      continue;
    }
    if (foldedKey && /^\s+/.test(line)) {
      result[foldedKey] = `${result[foldedKey]} ${line.trim()}`.trim();
    } else if (line.trim()) {
      foldedKey = null;
    }
  }
  return result;
}

async function walk(root, depth = 0) {
  if (depth > 5) return [];
  const found = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(root, entry.name);
    if (entry.isFile() && (entry.name === "SKILL.md" || (/skill/i.test(entry.name) && entry.name.toLowerCase().endsWith(".md")))) found.push(full);
    if (entry.isDirectory()) found.push(...await walk(full, depth + 1));
  }
  return found;
}

export async function scanSkills(roots) {
  const files = (await Promise.all((roots || []).filter(Boolean).map((root) => walk(path.resolve(root))))).flat();
  const unique = [...new Set(files)];
  const skills = [];
  for (const file of unique) {
    const raw = await readFile(file, "utf8");
    const meta = parseFrontmatter(raw);
    const info = await stat(file);
    const id = createHash("sha256").update(file).digest("hex").slice(0, 16);
    skills.push({
      id,
      name: meta.name || path.basename(path.dirname(file)),
      description: meta.description || "暂无描述",
      file,
      root: roots.find((root) => file.startsWith(path.resolve(root))) || "",
      format: path.basename(file) === "SKILL.md" ? "standard" : "compatible-file",
      version: createHash("sha256").update(raw).digest("hex").slice(0, 12),
      updatedAt: info.mtime.toISOString()
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

/**
 * 按 id 或名字找 Skill。
 *
 * id 是 sha256(**绝对路径**) 的前 16 位 —— 换台机器、或者把 Skill 挪个目录，
 * 同一个 Skill 的 id 就变了。单机上没问题，但仓库被克隆到别处时
 * （CI 上路径是 /home/runner/work/...）slots 里记的 id 全部对不上，
 * 整条流水线会在第一步就报「找不到 Skill」。
 *
 * 所以这里也接受**名字**：名字来自 Skill 文件 frontmatter 的 name 字段，
 * 跟路径无关，天然可移植。id 仍然优先匹配，老配置照常能用。
 * 找不到时把当前能扫到的都列出来 —— 光说「找不到 xxx」没法排查。
 */
export async function readSkillById(roots, idOrName) {
  const skills = await scanSkills(roots);
  const key = String(idOrName || "");
  const skill = skills.find((item) => item.id === key)
    || skills.find((item) => item.name === key);
  if (!skill) {
    const available = skills.map((item) => item.name).join("、") || "（一个都没扫到，检查 skillRoots）";
    throw new Error(`找不到 Skill：${key}。当前能扫到的有：${available}`);
  }
  return { ...skill, content: await readFile(skill.file, "utf8") };
}

export async function resolveSlots(config) {
  const entries = await Promise.all(Object.entries(config.slots || {}).map(async ([slot, id]) => {
    if (!id) return [slot, null];
    return [slot, await readSkillById(config.skillRoots, id)];
  }));
  return Object.fromEntries(entries);
}
