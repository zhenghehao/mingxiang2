import test from "node:test";
import assert from "node:assert/strict";
import { resolveEndingRule } from "../src/workflow.mjs";

test("默认两个时段都不唤醒", () => {
  for (const period of ["中午", "晚上"]) {
    const rule = resolveEndingRule(period, false);
    assert.match(rule, /不得唤醒/);
    assert.doesNotMatch(rule, /必须完整唤醒/);
  }
});

test("中午额外禁夜间词，晚上不禁", () => {
  const 午 = resolveEndingRule("中午", false);
  const 夜 = resolveEndingRule("晚上", false);
  assert.match(午, /不得出现「晚安」/);
  assert.doesNotMatch(夜, /不得出现「晚安」/);
  // 用户实际听到的两样东西，都要在中午这条里被点名挡掉
  for (const 词 of ["晚安", "睁开眼睛"]) {
    assert.ok(午.includes(词), `中午的铁律要点名挡「${词}」`);
  }
});

test("noonWake=true 能翻回 NSDR 那套", () => {
  assert.equal(resolveEndingRule("中午", true), "中午结尾必须完整唤醒，晚上结尾不得唤醒。");
  // 开关只管中午，晚上不受影响 —— 夜间被唤醒比午休睡过头严重得多
  assert.match(resolveEndingRule("晚上", true), /不得唤醒/);
});

test("默认配置里 noonWake 是关的", async () => {
  const cfg = JSON.parse(await (await import("node:fs/promises")).readFile(
    new URL("../data/default-config.json", import.meta.url), "utf8"));
  assert.equal(cfg.noonWake, false);
  assert.equal(resolveEndingRule("中午", cfg.noonWake === true).includes("必须完整唤醒"), false);
});

import { findNoonNightWords } from "../src/workflow.mjs";

test("中午的夜间说辞：道别话硬拦，可能出现在诗句里的只提醒", () => {
  for (const 词 of ["晚安", "好梦", "一夜好眠"]) {
    const r = findNoonNightWords(`……就这样，慢慢的。${词}。`);
    assert.deepEqual(r.硬拦, [词], `「${词}」必须被硬拦`);
  }
  // 这几个可能是引用的诗句原文（B 册第一句就是原句），误伤代价高，只提醒
  const 诗 = findNoonNightWords("今夜偏知春气暖。");
  assert.deepEqual(诗.硬拦, []);
  assert.deepEqual(诗.提醒, ["今夜"]);
});

test("干净的中午稿一条都不命中", () => {
  const 稿 = "芭蕉分绿与窗纱。你窗外那点绿，也照进来一些。就这样，睡一会儿。";
  const r = findNoonNightWords(稿);
  assert.deepEqual(r.硬拦, []);
  assert.deepEqual(r.提醒, []);
});

test("中午落款池整池都过得了这道闸", async () => {
  const { readFile } = await import("node:fs/promises");
  const phrases = JSON.parse(await readFile(new URL("../data/phrases.json", import.meta.url), "utf8"));
  for (const s of phrases["中午"].closing) {
    assert.deepEqual(findNoonNightWords(s).硬拦, [], `中午落款「${s}」不该被自己的闸拦下`);
    assert.deepEqual(findNoonNightWords(s).提醒, [], `中午落款「${s}」不该触发提醒`);
  }
  // 反证：顶层（夜间）落款池里确实有会被拦下的 —— 说明这道闸不是摆设
  const 会被拦 = phrases.closing.filter((s) => findNoonNightWords(s).硬拦.length);
  assert.ok(会被拦.length >= 2, "夜间落款池里应当有多条会被中午的闸拦下");
});
