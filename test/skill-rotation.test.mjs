import assert from "node:assert/strict";
import test from "node:test";
import { pickNextSkill, scriptSkillPool } from "../src/skill-rotation.mjs";

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
