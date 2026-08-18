import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { readJson, writeJson } from "./json-store.mjs";

function clean(value) {
  return String(value || "").replace(/[*_`]/g, "").trim();
}

export function normalizeTopicTitle(value) {
  return clean(value).normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function field(raw, name) {
  const match = raw.match(new RegExp(`(?:^|\\n)\\s*${name}\\s*[：:]\\s*([^\\n\\r]+)`, "m"));
  return clean(match?.[1] || "");
}

export function extractTopicRecord(value, extra = {}) {
  const raw = String(value || "");
  const titleLine = field(raw, "(?:标题|选题|主题)");
  const bracketed = titleLine.match(/【([^】]+)】/);
  const title = clean(bracketed?.[1] || titleLine.replace(/[。；;].*$/, ""));
  if (!title) return null;
  return {
    title,
    normalizedTitle: normalizeTopicTitle(title),
    themeFamily: field(raw, "主题族"),
    period: field(raw, "时段"),
    preview: field(raw, "画面预览") || clean(bracketed ? titleLine.replace(bracketed[0], "") : ""),
    createdAt: extra.createdAt || new Date().toISOString(),
    source: extra.source || ""
  };
}

function bigrams(value) {
  const normalized = normalizeTopicTitle(value);
  if (normalized.length < 2) return new Set([normalized]);
  return new Set([...Array(normalized.length - 1)].map((_, index) => normalized.slice(index, index + 2)));
}

function similarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  const intersection = [...a].filter((item) => b.has(item)).length;
  const union = new Set([...a, ...b]).size || 1;
  return intersection / union;
}

export function findDuplicateTopic(candidate, history = []) {
  const record = typeof candidate === "string" ? extractTopicRecord(candidate) : candidate;
  if (!record?.normalizedTitle) return null;
  return history.find((item) => {
    const prior = item.normalizedTitle || normalizeTopicTitle(item.title);
    if (!prior) return false;
    if (prior === record.normalizedTitle) return true;
    if (Math.min(prior.length, record.normalizedTitle.length) >= 4
      && (prior.includes(record.normalizedTitle) || record.normalizedTitle.includes(prior))) return true;
    return similarity(prior, record.normalizedTitle) >= 0.72;
  }) || null;
}

async function findTopicFiles(root, files = []) {
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await findTopicFiles(target, files);
    if (entry.isFile() && entry.name === "01-选题结果.txt") files.push(target);
  }
  return files;
}

function uniqueRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = record?.normalizedTitle || normalizeTopicTitle(record?.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function historyFile(config, workspaceRoot) {
  return path.join(path.resolve(workspaceRoot, config.app.outputRoot), "选题库.json");
}

export async function loadTopicHistory(config, workspaceRoot) {
  const outputRoot = path.resolve(workspaceRoot, config.app.outputRoot);
  const roots = [...new Set([outputRoot, path.join(workspaceRoot, "outputs")])];
  const ledger = await readJson(historyFile(config, workspaceRoot), { topics: [] });
  const scanned = [];
  for (const root of roots) {
    for (const file of await findTopicFiles(root)) {
      const content = await readFile(file, "utf8").catch(() => "");
      const record = extractTopicRecord(content, { source: file });
      if (record) scanned.push(record);
    }
  }
  return uniqueRecords([...(ledger.topics || []), ...scanned]);
}

export function formatTopicHistory(records = []) {
  if (!records.length) return "（选题库为空）";
  return records.map((item, index) => `${index + 1}. 标题：${item.title}；主题族：${item.themeFamily || "未知"}；画面：${item.preview || "未记录"}`).join("\n");
}

export async function recordTopic(config, workspaceRoot, value, extra = {}) {
  const record = extractTopicRecord(value, extra);
  if (!record) throw new Error("自动选题结果缺少标题，无法写入选题库");
  const file = historyFile(config, workspaceRoot);
  const current = await loadTopicHistory(config, workspaceRoot);
  // 只留最近 300 条。上限是 2026-08-18 加的：在这之前台账只在本机长，
  // 而本机跑得少所以没人碰到边界；把它接到云端（每天 3 篇）之后就是每年 1000 条，
  // 而 formatTopicHistory 会把**每一条**都拼进选题提示词 —— 不封顶的话
  // 提示词会一年比一年长，最后自己把自己撑爆。
  // 300 条≈100 天，比「不与近期重样」实际需要的窗口宽得多。
  const topics = uniqueRecords([record, ...current]).slice(0, 300);
  await mkdir(path.dirname(file), { recursive: true });
  await writeJson(file, { version: 1, updatedAt: new Date().toISOString(), topics });
  return { record, file, count: topics.length };
}
