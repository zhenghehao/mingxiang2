/**
 * 写稿 Skill 的轮动。
 *
 * 六个文体各写各的（道禅 / 古诗词 / 童话 / 动漫 / 华语歌 / 自然场景），
 * 固定用一个会让整个频道听起来是同一篇。
 *
 * 两种挑法，由 config.scriptRotation 决定：
 *
 *   random（默认）  随机抽，但**排除上一次刚用过的那个**。
 *   lru             最久没用的先上。
 *
 * 2026-08-14 把默认从 lru 改成 random。原来这里写着「轮动的目标不是随机」，
 * 理由是"随机会连着抽中同一个"。那个理由只对**纯**随机成立，而 lru 自己有个
 * 更大的毛病：池子固定时它退化成一条死循环——首轮之后永远是
 * 道禅→古诗→童话→动漫→歌→自然→道禅→…，顺序一次都不会变。
 * 单看一篇看不出来，连着听一周就是另一种单调，而"太单一"正是当初要拆六册的原因。
 *
 * 所以 random 保留了 lru 唯一真正有用的那一半（不让"又是它"连着出现），
 * 只是不再规定第 2 到第 6 个的先后。排除项只排上一个、不排更多：
 * 排得越多越接近 lru，六个里排掉五个就完全等于 lru 了。
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

/**
 * 随机挑一个，但不挑上一次刚用过的那个。
 *
 * random 注入进来是为了可测：测试传一个定值函数，就能断言"给定随机数出哪个"，
 * 不用靠跑一万次看分布。生产环境不传，走 Math.random。
 */
export function pickRandomSkill(pool, history = [], { random = Math.random } = {}) {
  if (!pool.length) return "";
  if (pool.length === 1) return pool[0];
  const last = history[0];
  const candidates = pool.filter((name) => name !== last);
  // 池子里只有上一次那一个能选时（比如池子被删得只剩它），宁可重复也不能返回空
  const list = candidates.length ? candidates : pool;
  // random() 按规范取不到 1，但传进来的桩函数可能不守规矩，夹一下防越界
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
}

/** 按模式分派。认不出来的模式一律当 random —— 默认值不该因为配置写错就变。 */
export function pickScriptSkill(pool, history = [], mode = "random", options = {}) {
  return String(mode).trim().toLowerCase() === "lru"
    ? pickNextSkill(pool, history)
    : pickRandomSkill(pool, history, options);
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
 * 从池子里挑下一句：随机，但不挑上一次刚用过的那句。
 * 池子为空时返回空串，由调用方决定不注入。
 *
 * 2026-08-18 从 LRU 改成 random。LRU 在**历史为空**时是死的：所有句子并列
 * rank -1，pickNextSkill 的循环里 `a === -1 && b !== -1` 和 `a > b` 都不成立，
 * 谁也顶不掉谁，于是永远返回 pool[0]。
 *
 * 而云端的历史**永远是空的** —— 台账写在 output/语句轮动.json，output/* 在
 * .gitignore 里，Actions 每次都是干净 runner。结果就是每一次云端跑：
 * 古诗册开场必是「床前明月光」（池子第一条），落款必是「晚安，亲爱的」（同理）。
 * 用户的原话是「为什么诗歌每次都是窗前明月光」和「中午怎么会出现晚安」，
 * 两条抱怨是同一个 bug。本机因为台账留着，反而看不出来。
 *
 * random 不依赖历史也能散开，历史有的时候还能顺带保证不连着重样 ——
 * 正是文体轮动 2026-08-14 从 lru 改 random 时的同一个理由。
 */
export function pickPhrase(pool, history = [], { random = Math.random } = {}) {
  return pickRandomSkill(Array.isArray(pool) ? pool.filter(Boolean) : [], history, { random });
}

/**
 * 取某个 skill 在某个时段该用的句子池。
 *
 * 时段覆盖写在 phrases["中午"] 底下，结构和顶层一样（opening 按册分池、
 * closing 是全局数组）。没有覆盖就用顶层的（＝晚上）。
 *
 * 关键约束：**opening 的时段覆盖不回落到中午的 default**。
 * 六册的首句是硬规则（B 册必须是古诗原句、C 册必须是「很久以前」式时间滑门、
 * F 册必须是不带「你」的客观陈述）。哪一册没写中午版，说明它的首句本来就
 * 不分时段（「很久以前，森林里有一间小屋」中午念也没毛病），这时候硬塞一句
 * 中午 default（「这个上午已经过去了」）会直接违反该册的首句要求。
 * 只有本来就在吃顶层 default 的册，才允许改吃中午 default。
 *
 * closing 是全局池，没有分册规则，整池替换即可。
 */
export function poolForPeriod(phrases, kind, skillName, period) {
  // 有些册的首句是 skill 自己按本篇选题挑的（古诗册要一句贴合题目意境的名句），
  // 代码看不见题目，只看得见册名 —— 从固定句池里挑必然对不上，
  // 还会把「万首名句」缩成「池子里那几句」。返回空池＝那段提示词整段不出现。
  if (kind === "opening" && Array.isArray(phrases?.自选首句) && phrases.自选首句.includes(skillName)) {
    return [];
  }
  const 顶层 = phrases?.[kind];
  const 覆盖 = period ? phrases?.[period]?.[kind] : null;
  if (!覆盖) return poolFor(顶层, skillName);
  // 数组＝全局池（落款）：整池换掉
  if (Array.isArray(覆盖)) return 覆盖.filter(Boolean);
  if (typeof 覆盖 !== "object") return poolFor(顶层, skillName);

  const 本册覆盖 = 覆盖[skillName];
  if (Array.isArray(本册覆盖) && 本册覆盖.length) return 本册覆盖.filter(Boolean);

  const 本册顶层 = 顶层 && !Array.isArray(顶层) ? 顶层[skillName] : null;
  const 有分册规则 = Array.isArray(本册顶层) && 本册顶层.length;
  if (!有分册规则 && Array.isArray(覆盖.default) && 覆盖.default.length) {
    return 覆盖.default.filter(Boolean);
  }
  return poolFor(顶层, skillName);
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
