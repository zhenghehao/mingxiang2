import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pickPhrase, pickNextSkill, poolForPeriod, poolFor } from "../src/skill-rotation.mjs";

const phrases = JSON.parse(await readFile(new URL("../data/phrases.json", import.meta.url), "utf8"));

test("空历史下 pickPhrase 会散开（这正是「每次都是床前明月光」的病根）", () => {
  const pool = phrases.opening["sleep-hypnosis-tonghua"];
  assert.ok(pool.length >= 8, "童话池至少 8 条");

  // 云端的真实条件：台账在 output/ 里，Actions 每次都是干净 runner → 历史恒为空
  const 命中 = new Set();
  for (let i = 0; i < 2000; i += 1) 命中.add(pickPhrase(pool, []));
  assert.equal(命中.size, pool.length, "空历史下每一条都应该有机会被选中");

  // 反证：换回原来的 LRU，同样条件下**只会**出现池子第一条。
  // 不做这一步的话，上面那个断言换成任何一个非退化实现都能过，证不了原来错在哪。
  const lru = new Set();
  for (let i = 0; i < 2000; i += 1) lru.add(pickNextSkill(pool, []));
  assert.deepEqual([...lru], [pool[0]], "LRU 在空历史下恒返回 pool[0]");
});

test("pickPhrase 仍然不挑上一次刚用过的那句", () => {
  const pool = phrases.closing;
  for (let i = 0; i < 500; i += 1) {
    assert.notEqual(pickPhrase(pool, [pool[0]]), pool[0]);
  }
});

test("中午取到中午的落款，一条夜间话都不带", () => {
  const 夜 = poolForPeriod(phrases, "closing", "sleep-hypnosis-ziran", "晚上");
  const 午 = poolForPeriod(phrases, "closing", "sleep-hypnosis-ziran", "中午");
  assert.deepEqual(夜, phrases.closing);
  assert.notDeepEqual(午, 夜);
  for (const s of 午) {
    assert.doesNotMatch(s, /晚安|好梦|夜|天亮|一整晚/, `中午落款不该出现夜间词：${s}`);
  }
  // 顶层池子确实全是夜间话 —— 否则这个测试是在证一件本来就成立的事
  assert.ok(phrases.closing.some((s) => /晚安/.test(s)), "顶层落款里本来就有「晚安」");
});

test("没写中午版的册，首句**不会**被替换成中午 default", () => {
  // C 册（童话）首句必须是「很久以前」式的时间滑门，硬塞一句
  // 「这个上午已经过去了」会直接违反它的首句硬规则
  const 童话午 = poolForPeriod(phrases, "opening", "sleep-hypnosis-tonghua", "中午");
  assert.deepEqual(童话午, phrases.opening["sleep-hypnosis-tonghua"]);
  assert.ok(童话午.every((s) => /很久|从前|那年|那是/.test(s)));

  // 写了中午版的册，就要换过去
  const 自然午 = poolForPeriod(phrases, "opening", "sleep-hypnosis-ziran", "中午");
  assert.deepEqual(自然午, phrases["中午"].opening["sleep-hypnosis-ziran"]);
  assert.ok(自然午.every((s) => !/你/.test(s)), "F 册首句不得出现「你」");
  assert.ok(自然午.every((s) => !/夜|晚/.test(s)), "中午的客观陈述不该提夜晚");

  // 本来就吃顶层 default 的册（池子里没它），改吃中午 default
  const 无名午 = poolForPeriod(phrases, "opening", "sleep-hypnosis-不存在", "中午");
  assert.deepEqual(无名午, phrases["中午"].opening.default);
  const 无名夜 = poolForPeriod(phrases, "opening", "sleep-hypnosis-不存在", "晚上");
  assert.deepEqual(无名夜, phrases.opening.default);
});

test("古诗册的首句由 skill 自己挑，代码一句都不塞", () => {
  assert.ok(phrases.自选首句.includes("sleep-hypnosis-gushiwen"));
  for (const period of ["晚上", "中午"]) {
    assert.deepEqual(poolForPeriod(phrases, "opening", "sleep-hypnosis-gushiwen", period), []);
    // 空池 → pickPhrase 返回空串 → 提示词里那段「第一句用这句」整段不出现
    assert.equal(pickPhrase(poolForPeriod(phrases, "opening", "sleep-hypnosis-gushiwen", period), []), "");
  }
  // 落款不受影响：它没有「贴合选题」这个要求，照样由代码轮
  assert.ok(poolForPeriod(phrases, "closing", "sleep-hypnosis-gushiwen", "中午").length > 0);

  // 别的册没上名单，仍然由代码给首句 —— 否则等于把这个机制悄悄推给了所有人
  for (const 册 of ["sleep-hypnosis-tonghua", "sleep-hypnosis-ziran", "sleep-hypnosis-dao-chan"]) {
    assert.ok(poolForPeriod(phrases, "opening", 册, "晚上").length > 0, 册 + " 仍应由代码给首句");
  }
});

test("古诗册 SKILL 里不再有封闭清单和点名例子", async () => {
  const md = await readFile(new URL("../skills/sleep-hypnosis-gushiwen/SKILL.md", import.meta.url), "utf8");
  // 白名单措辞：这句话在的时候，「符合选题意境的名句」是做不到的
  assert.doesNotMatch(md, /表外的句子.*一律不引/);
  assert.doesNotMatch(md, /不构成可选范围/);
  // 反复被写出来的那首，只应作为「要克制」的反例出现一次
  const 静夜思 = (md.match(/静夜思/g) || []).length;
  assert.equal(静夜思, 1, "《静夜思》只应在「尤其要克制」那一句里出现");
  assert.doesNotMatch(md, /床前明月光/);
  assert.doesNotMatch(md, /疑是地上霜/);
  // 新规则必须真的写进去了
  assert.match(md, /意境贴合本篇选题/);
  assert.match(md, /本册不设可选诗篇清单/);
});

test("poolForPeriod 在没有时段覆盖时退回 poolFor 的老行为", () => {
  const 无覆盖 = { opening: phrases.opening, closing: phrases.closing };
  for (const 册 of ["sleep-hypnosis-gushiwen", "sleep-hypnosis-tonghua", "谁也不是"]) {
    assert.deepEqual(
      poolForPeriod(无覆盖, "opening", 册, "中午"),
      poolFor(无覆盖.opening, 册)
    );
  }
});
