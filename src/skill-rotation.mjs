/**
 * 写稿 Skill 的轮动。
 *
 * 六个文体各写各的（道禅 / 古诗词 / 童话 / 动漫 / 华语歌 / 自然场景），
 * 固定用一个会让整个频道听起来是同一篇。轮动的目标不是"随机"，而是
 * **最久没用的先上** —— 随机会连着抽中同一个，而听众最容易察觉的正是"又是它"。
 *
 * 状态存在成品目录下的「写稿轮动.json」，和「选题库.json」放一起：
 * 那里本来就是跨次运行的记忆，不进仓库，换机器重来一遍也无所谓。
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { readJson, writeJson } from "./json-store.mjs";

function ledgerFile(config, workspaceRoot) {
  return path.join(path.resolve(workspaceRoot, config.app.outputRoot), "写稿轮动.json");
}

/** slots.script 允许写成字符串（固定一个）或数组（轮动）。统一成数组。 */
export function scriptSkillPool(slots) {
  const value = slots?.script;
  if (Array.isArray(value)) return [...new Set(value.map((v) => String(v || "").trim()).filter(Boolean))];
  const single = String(value || "").trim();
  return single ? [single] : [];
}

/**
 * 从池子里挑下一个：最久没用的优先，从没用过的排最前。
 *
 * 传入 history 是「最近用过的名字，新的在前」。不直接存时间戳是因为
 * 只关心先后，不关心间隔多久 —— 存名字顺序更简单，也更好人肉看懂。
 */
export function pickNextSkill(pool, history = []) {
  if (!pool.length) return "";
  // 池子里只有一个就没什么可轮的
  if (pool.length === 1) return pool[0];
  const rank = (name) => {
    const index = history.indexOf(name);
    // 没用过 → 排最前（-1 比任何下标都小，正是我们要的语义）
    return index === -1 ? -1 : index;
  };
  // 下标越大＝用得越久远。取最久远的那个；并列时按池子里的书写顺序，
  // 保证同样的输入永远给同样的输出（可测、可复现）。
  let best = pool[0];
  for (const name of pool) {
    const a = rank(name);
    const b = rank(best);
    if (a === -1 && b !== -1) { best = name; continue; }
    if (a !== -1 && b === -1) continue;
    if (a > b) best = name;
  }
  return best;
}

export async function loadSkillHistory(config, workspaceRoot) {
  const ledger = await readJson(ledgerFile(config, workspaceRoot), { used: [] });
  return Array.isArray(ledger.used) ? ledger.used : [];
}

/** 记一笔。名字挪到最前，重复的去掉，只留最近 50 条。 */
export async function recordSkillUse(config, workspaceRoot, name) {
  if (!name) return [];
  const file = ledgerFile(config, workspaceRoot);
  const current = await loadSkillHistory(config, workspaceRoot);
  const used = [name, ...current.filter((item) => item !== name)].slice(0, 50);
  await mkdir(path.dirname(file), { recursive: true });
  await writeJson(file, { version: 1, updatedAt: new Date().toISOString(), used });
  return used;
}

// ── 语句轮动（开场引导语 / 结尾落款）────────────────────────────────────
//
// 和文体轮动同一套策略，只是池子换成句子。**必须由代码挑**：让模型自己
// 「轮换使用」实测不管用 —— 六册那批六篇里三篇结尾都是「晚安，亲爱的」，
// 而各册规范都写着要轮换。模型没有跨篇记忆，说了也做不到。

function phraseLedgerFile(config, workspaceRoot) {
  return path.join(path.resolve(workspaceRoot, config.app.outputRoot), "语句轮动.json");
}

export async function loadPhraseHistory(config, workspaceRoot) {
  const ledger = await readJson(phraseLedgerFile(config, workspaceRoot), {});
  return ledger && typeof ledger === "object" ? ledger : {};
}

/**
 * 从池子里挑下一句。复用 pickNextSkill 的 LRU 语义，只是这里的「名字」是整句话。
 * 池子为空时返回空串，由调用方决定不注入。
 */
export function pickPhrase(pool, history = []) {
  return pickNextSkill(Array.isArray(pool) ? pool.filter(Boolean) : [], history);
}

/**
 * 取某个 skill 该用的句子池。
 *
 * 开场按册分池：六册各有互不相容的首句要求（A 要陈述性减法、B 要古诗原句、
 * C 要时间滑门且无「你」、D 要一个声音、F 要客观陈述且无「你」），全局共用
 * 一套必然违反其中四册 —— 实测 v4 就是这么崩的：两篇跌破字数下限、B 册整册
 * 身份丢失、A 册在引导语之后又卸载了一遍。
 *
 * 传进来的可以是数组（老格式，全局共用）或对象（新格式，按 skill 名分池）。
 * 两种都接受，省得改了配置格式就把旧配置读崩。
 */
export function poolFor(pools, skillName) {
  if (Array.isArray(pools)) return pools;
  if (!pools || typeof pools !== "object") return [];
  const named = pools[skillName];
  if (Array.isArray(named) && named.length) return named;
  return Array.isArray(pools.default) ? pools.default : [];
}

/** 记一笔。kind 是 "opening" / "closing" 这类分类，各自一条独立的历史。 */
export async function recordPhraseUse(config, workspaceRoot, kind, phrase) {
  if (!kind || !phrase) return {};
  const file = phraseLedgerFile(config, workspaceRoot);
  const all = await loadPhraseHistory(config, workspaceRoot);
  const current = Array.isArray(all[kind]) ? all[kind] : [];
  all[kind] = [phrase, ...current.filter((item) => item !== phrase)].slice(0, 50);
  all.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  await writeJson(file, all);
  return all;
}
