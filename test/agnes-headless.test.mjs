import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  agnesHeadlessEnabled,
  extractJSON,
  resolveCoverPath,
  resolveKeyPools
} from "../src/agnes-headless.mjs";
import { SKILL_DIRECTOR, SKILL_JUDGE, SKILL_MOTION } from "../src/agnes-prompts.mjs";

const keys = (n) => Array.from({ length: n }, (_, i) => `k${i + 1}`);

test("key 够多时按尾部切出视频专用池，两池不重叠", () => {
  const pools = resolveKeyPools(keys(15), [], 3);
  assert.equal(pools.partitioned, true);
  assert.deepEqual(pools.imageKeys, keys(12));
  assert.deepEqual(pools.videoKeys, ["k13", "k14", "k15"]);
  // 不重叠才是这套分池的意义所在：生图烧掉的限流窗口不能牵连生视频
  const overlap = pools.imageKeys.filter((k) => pools.videoKeys.includes(k));
  assert.deepEqual(overlap, []);
});

test("key 太少时不分池，否则生图并发会被压到 1", () => {
  // 4 个 key 留 3 个给视频，生图只剩 1 个 —— 这种情况必须退回共用
  const pools = resolveKeyPools(keys(4), [], 3);
  assert.equal(pools.partitioned, false);
  assert.deepEqual(pools.imageKeys, keys(4));
  assert.deepEqual(pools.videoKeys, keys(4));
});

test("刚好够分的边界：生图至少要留 2 个", () => {
  assert.equal(resolveKeyPools(keys(5), [], 3).partitioned, true);
  assert.deepEqual(resolveKeyPools(keys(5), [], 3).imageKeys, ["k1", "k2"]);
  assert.equal(resolveKeyPools(keys(4), [], 3).partitioned, false);
});

test("reservedForVideo 为 0 时不分池", () => {
  const pools = resolveKeyPools(keys(9), [], 0);
  assert.equal(pools.partitioned, false);
  assert.deepEqual(pools.videoKeys, keys(9));
});

test("显式给了 videoKeys 就完全按它来，不再从主池切", () => {
  const pools = resolveKeyPools(keys(9), ["vid-a", "vid-b"], 3);
  assert.deepEqual(pools.videoKeys, ["vid-a", "vid-b"]);
  assert.deepEqual(pools.imageKeys, keys(6));
});

test("空串和空白 key 会被剔掉，不占名额", () => {
  const pools = resolveKeyPools(["a", "", "  ", "b", null, "c"], [], 0);
  assert.deepEqual(pools.imageKeys, ["a", "b", "c"]);
});

test("重复的 key 只算一个 —— 限流按 key 算，不按槽位算", () => {
  // 同一个 key 填 3 遍不会变成 3 份配额。不去重的话池子被虚撑大，
  // 「留 3 个给视频」可能留的是同一个 key 的三个副本，分池就白做了。
  const pools = resolveKeyPools(["a", "a", "a", "b", "c", "d"], [], 1);
  assert.deepEqual(pools.imageKeys, ["a", "b", "c"]);
  assert.deepEqual(pools.videoKeys, ["d"]);
  const overlap = pools.imageKeys.filter((k) => pools.videoKeys.includes(k));
  assert.deepEqual(overlap, []);
});

test("重复导致 key 不够时，分池会如实退化而不是假装够用", () => {
  // 表面 6 个，去重后只有 2 个 —— 必须不分池，而不是切出一个空的生图池
  const pools = resolveKeyPools(["a", "a", "a", "b", "b", "b"], [], 3);
  assert.equal(pools.partitioned, false);
  assert.deepEqual(pools.imageKeys, ["a", "b"]);
  assert.deepEqual(pools.videoKeys, ["a", "b"]);
});

test("开关默认关闭，只有显式 enabled 才走 headless", () => {
  assert.equal(agnesHeadlessEnabled({}), false);
  assert.equal(agnesHeadlessEnabled({ agnesHeadless: {} }), false);
  assert.equal(agnesHeadlessEnabled({ agnesHeadless: { enabled: false } }), false);
  assert.equal(agnesHeadlessEnabled({ agnesHeadless: { enabled: true } }), true);
});

test("extractJSON 能剥掉围栏和前后废话", () => {
  assert.deepEqual(extractJSON('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(extractJSON('好的，结果如下：\n{"best":2}\n希望有帮助'), { best: 2 });
});

test("extractJSON 不会被字符串里的括号骗到", () => {
  const raw = '{"best_reason":"画面里有 } 和 { 这样的符号","best":1}';
  assert.deepEqual(extractJSON(raw), { best_reason: "画面里有 } 和 { 这样的符号", best: 1 });
});

test("extractJSON 遇到截断的 JSON 明确报错，而不是返回半个对象", () => {
  assert.throws(() => extractJSON('{"scores":[{"total":8'), /不完整|截断/);
  assert.throws(() => extractJSON("模型只说了一堆废话"), /没有 JSON/);
  assert.throws(() => extractJSON(null), /空回复/);
});

test("三段提示词都在，且候选数会被代入", () => {
  assert.match(SKILL_DIRECTOR(6), /6/);
  assert.match(SKILL_JUDGE(6), /6/);
  assert.ok(SKILL_MOTION().length > 500);
  // 导演词按张数变化，评委词也是 —— 改候选数时两边都要跟着变
  assert.notEqual(SKILL_DIRECTOR(6), SKILL_DIRECTOR(9));
  assert.notEqual(SKILL_JUDGE(6), SKILL_JUDGE(9));
});

test("9 把 key：6 把生图、3 把待命，待命池首轮不参与", () => {
  const pools = resolveKeyPools(keys(9), [], 3);
  assert.deepEqual(pools.imageKeys, keys(6));
  assert.deepEqual(pools.spareKeys, ["k7", "k8", "k9"]);
  // 待命的意义就在于「没被用过」——和生图池有任何交集都等于白留
  assert.deepEqual(pools.spareKeys.filter((k) => pools.imageKeys.includes(k)), []);
});

test("片头封面：留空走仓库自带那张，而不是没有封面", () => {
  // 这条是回归测试。云端跑出来的成片曾经整轮没有片头，原因就是 default-config
  // 里 coverPath 留了空串，而空串当时被解释成「不要封面」——漏填和主动关闭
  // 必须区分开，否则丢了片头也没有任何迹象。
  for (const blank of ["", "   ", null, undefined]) {
    assert.equal(path.basename(resolveCoverPath(blank)), "cover.png");
    assert.ok(path.isAbsolute(resolveCoverPath(blank)), "必须解析成绝对路径，否则换工作目录就找不着");
  }
});

test("片头封面：仓库里真的带着那张图", () => {
  // 默认值指向仓库内的文件，文件本身没跟着提交的话默认值就是个空头支票。
  // CI 上没有 data/config.json，全靠这张兜底。
  assert.ok(existsSync(resolveCoverPath("")), "assets/cover.png 必须在仓库里");
});

test("片头封面：相对路径按仓库根解析，绝对路径原样用", () => {
  const rel = resolveCoverPath("assets/cover.png");
  assert.equal(resolveCoverPath(""), rel, "默认值和显式写同一个相对路径应当等价");
  assert.equal(resolveCoverPath("/tmp/别的封面.png"), "/tmp/别的封面.png");
});

test("片头封面：只有显式 off 才真的不要封面", () => {
  for (const off of ["off", "OFF", "none", "false", "no"]) {
    assert.equal(resolveCoverPath(off), "");
  }
});

test("不分池时待命池为空，生图退回在主池里轮换", () => {
  const pools = resolveKeyPools(keys(4), [], 3);
  assert.equal(pools.partitioned, false);
  assert.deepEqual(pools.spareKeys, [], "没分池就不该有待命池，否则会重复使用同一批 key");
  assert.deepEqual(pools.imageKeys, keys(4));
});
