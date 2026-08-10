import assert from "node:assert/strict";
import test from "node:test";
import { pickNextSkill, poolFor, scriptSkillPool } from "../src/skill-rotation.mjs";

const 六个 = [
  "sleep-dao-chan", "sleep-gushiwen", "sleep-tonghua",
  "sleep-dongman", "sleep-huayu-song", "sleep-nature-scene"
];

test("槽位写字符串＝不轮动，写数组＝轮动", () => {
  assert.deepEqual(scriptSkillPool({ script: "sleep-dao-chan" }), ["sleep-dao-chan"]);
  assert.deepEqual(scriptSkillPool({ script: 六个 }), 六个);
  assert.deepEqual(scriptSkillPool({}), []);
  assert.deepEqual(scriptSkillPool({ script: "" }), []);
});

test("池子里的重复项只算一个", () => {
  // 配置里手滑写重了不该让某个文体出现频率翻倍
  assert.deepEqual(scriptSkillPool({ script: ["a", "b", "a", "  ", "b"] }), ["a", "b"]);
});

test("没有历史时按池子顺序从第一个开始", () => {
  assert.equal(pickNextSkill(六个, []), "sleep-dao-chan");
});

test("没用过的优先于用过的", () => {
  // 刚用过 dao-chan，下一个必须是还没登场过的
  assert.equal(pickNextSkill(六个, ["sleep-dao-chan"]), "sleep-gushiwen");
  assert.equal(pickNextSkill(六个, ["sleep-gushiwen", "sleep-dao-chan"]), "sleep-tonghua");
});

test("六个都用过之后，回到最久没用的那个", () => {
  // history 新的在前，所以最后一个是最久远的
  const used = ["sleep-nature-scene", "sleep-huayu-song", "sleep-dongman",
    "sleep-tonghua", "sleep-gushiwen", "sleep-dao-chan"];
  assert.equal(pickNextSkill(六个, used), "sleep-dao-chan");
});

test("连续六次不会重样，第七次才回到第一个", () => {
  // 这条是整个轮动的意义所在：随机会连着抽中同一个，而听众最烦的正是「又是它」
  let history = [];
  const 顺序 = [];
  for (let i = 0; i < 7; i += 1) {
    const picked = pickNextSkill(六个, history);
    顺序.push(picked);
    history = [picked, ...history.filter((x) => x !== picked)];
  }
  assert.deepEqual(new Set(顺序.slice(0, 6)).size, 6, "前六次必须六个各来一遍");
  assert.equal(顺序[6], 顺序[0], "第七次回到第一个，形成闭环");
});

test("池子里只有一个时永远是它，历史再多也不影响", () => {
  assert.equal(pickNextSkill(["only"], ["only", "only", "only"]), "only");
});

test("历史里有已经不在池子里的名字，不影响挑选", () => {
  // 用户从配置里删掉某个文体后，台账里仍留着它的记录
  assert.equal(pickNextSkill(["a", "b"], ["已删除的旧文体", "a"]), "b");
});

test("空池子返回空串，不抛异常", () => {
  // 槽位没配时应当由上层报「请先绑定 Skill」，不该在这里炸
  assert.equal(pickNextSkill([], ["a"]), "");
});

// ── 按册分池 ────────────────────────────────────────────────────────────
test("poolFor 按 skill 名取池，取不到回落 default", () => {
  const pools = {
    default: ["通用一", "通用二"],
    "sleep-hypnosis-gushiwen": ["床前明月光。", "空山新雨后。"]
  };
  assert.deepEqual(poolFor(pools, "sleep-hypnosis-gushiwen"), ["床前明月光。", "空山新雨后。"]);
  assert.deepEqual(poolFor(pools, "sleep-hypnosis-writer"), ["通用一", "通用二"]);
  assert.deepEqual(poolFor(pools, "没配过的skill"), ["通用一", "通用二"]);
});

test("poolFor 兼容老格式（整个就是一个数组）", () => {
  // 配置格式换过一次；旧配置不该因此读崩
  assert.deepEqual(poolFor(["甲", "乙"], "任何skill"), ["甲", "乙"]);
});

test("poolFor 面对空值不抛异常", () => {
  for (const bad of [null, undefined, 0, "字符串"]) {
    assert.deepEqual(poolFor(bad, "x"), [], `${bad} 应当返回空数组`);
  }
  assert.deepEqual(poolFor({ "sleep-x": [] }, "sleep-x"), [], "空池子要回落，而不是返回空池");
});

test("六册各自的引导语必须守住该册的首句硬规则", async () => {
  // 这条防的是「改了句池却忘了各册的硬要求」——实测 v4 就是因为全局共用一套
  // 引导语，四册的首句要求被违反，两篇跌破字数下限、B 册整册身份丢失。
  const { readFile } = await import("node:fs/promises");
  const phrases = JSON.parse(await readFile(new URL("../data/phrases.json", import.meta.url), "utf8"));
  const 无你 = (s) => !s.includes("你");
  const 规则 = {
    "sleep-hypnosis-gushiwen": [(s) => s.length <= 10 && 无你(s), "古诗原句：短句、无第二人称"],
    "sleep-hypnosis-tonghua": [(s) => 无你(s) && /很久|从前|那年|多年前|那(个|年)/.test(s), "时间滑门、前两句无「你」"],
    "sleep-hypnosis-dongman": [无你, "纯声音、三句内无「你」"],
    "sleep-hypnosis-ziran": [无你, "客观陈述、不出现「你」"]
  };
  for (const [skill, [ok, why]] of Object.entries(规则)) {
    const pool = poolFor(phrases.opening, skill);
    assert.ok(pool.length >= 4, `${skill} 句池太小，轮不开`);
    for (const s of pool) assert.ok(ok(s), `${skill} 违反「${why}」：${s}`);
  }
});
