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

export async function readSkillById(roots, id) {
  const skills = await scanSkills(roots);
  const skill = skills.find((item) => item.id === id);
  if (!skill) throw new Error(`找不到 Skill：${id}`);
  return { ...skill, content: await readFile(skill.file, "utf8") };
}

export async function resolveSlots(config) {
  const entries = await Promise.all(Object.entries(config.slots || {}).map(async ([slot, id]) => {
    if (!id) return [slot, null];
    return [slot, await readSkillById(config.skillRoots, id)];
  }));
  return Object.fromEntries(entries);
}
