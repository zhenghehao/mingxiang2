import assert from "node:assert/strict";
import test from "node:test";
import { applyEnvOverrides, localOnlyPaths } from "../src/env-config.mjs";

const base = () => ({
  app: { outputRoot: "/Users/shareit/Desktop/output", port: 4319 },
  skillRoots: ["/Users/shareit/Desktop/skills"],
  media: { bgmRoot: "/Users/shareit/bgm", videoRoot: "/Users/shareit/video", ffmpegPath: "bundled" },
  agnes: { projectRoot: "/Users/shareit/Desktop/agnes-playground", enabled: false },
  agnesHeadless: {
    enabled: true, baseUrl: "https://api.agnes-ai.cn",
    apiKeys: ["cfg-1", "cfg-2"], candidateCount: 6, reservedForVideo: 1
  }
});

test("什么都不设时，配置原样返回 —— 本机行为不能被这层改变", () => {
  const { config, applied } = applyEnvOverrides(base(), {});
  assert.deepEqual(config, base());
  assert.deepEqual(applied, []);
});

test("空字符串等于没设，不能把配置覆盖成空", () => {
  // CI 里常见：变量声明了但没赋值。这时必须回落，而不是把 outputRoot 抹成 ""
  const { config } = applyEnvOverrides(base(), {
    MEDITATION_OUTPUT_ROOT: "", AGNES_API_KEYS: "", AGNES_BASE_URL: "   "
  });
  assert.equal(config.app.outputRoot, "/Users/shareit/Desktop/output");
  assert.deepEqual(config.agnesHeadless.apiKeys, ["cfg-1", "cfg-2"]);
});

test("设了就覆盖，且不影响同级其他字段", () => {
  const { config } = applyEnvOverrides(base(), { MEDITATION_OUTPUT_ROOT: "/srv/out" });
  assert.equal(config.app.outputRoot, "/srv/out");
  assert.equal(config.app.port, 4319, "端口不该被动到");
});

test("列表类支持逗号和换行，顺手去空白去重", () => {
  const { config } = applyEnvOverrides(base(), {
    AGNES_API_KEYS: "k1, k2\nk3 ,k2,, k1 ",
    MEDITATION_SKILL_ROOTS: "/a,/b"
  });
  assert.deepEqual(config.agnesHeadless.apiKeys, ["k1", "k2", "k3"]);
  assert.deepEqual(config.skillRoots, ["/a", "/b"]);
});

test("数字类只认得数，垃圾值回落", () => {
  const ok = applyEnvOverrides(base(), { AGNES_CANDIDATE_COUNT: "9" }).config;
  assert.equal(ok.agnesHeadless.candidateCount, 9);
  const bad = applyEnvOverrides(base(), { AGNES_CANDIDATE_COUNT: "六" }).config;
  assert.equal(bad.agnesHeadless.candidateCount, 6, "解析不出数字就该保持原值");
});

test("布尔类只有明确写 true/1/yes 才算开", () => {
  const on = applyEnvOverrides(base(), { AGNES_HEADLESS_ENABLED: "true" }).config;
  const off = applyEnvOverrides(base(), { AGNES_HEADLESS_ENABLED: "false" }).config;
  const weird = applyEnvOverrides(base(), { AGNES_HEADLESS_ENABLED: "maybe" }).config;
  assert.equal(on.agnesHeadless.enabled, true);
  assert.equal(off.agnesHeadless.enabled, false);
  assert.equal(weird.agnesHeadless.enabled, false, "看不懂的值按关处理，不要误开");
});

test("不会改到传进来的原对象", () => {
  const original = base();
  applyEnvOverrides(original, { MEDITATION_OUTPUT_ROOT: "/srv/out" });
  assert.equal(original.app.outputRoot, "/Users/shareit/Desktop/output");
});

test("localOnlyPaths 能指出还剩哪些本机路径，以及该设哪个变量", () => {
  const found = localOnlyPaths(base());
  const paths = found.map((item) => item.path).sort();
  assert.deepEqual(paths, ["agnes.projectRoot", "app.outputRoot", "media.bgmRoot", "media.videoRoot", "skillRoots"]);
  assert.equal(found.find((item) => item.path === "app.outputRoot").env, "MEDITATION_OUTPUT_ROOT");
});

test("路径都换成非本机后，localOnlyPaths 干净", () => {
  const { config } = applyEnvOverrides(base(), {
    MEDITATION_OUTPUT_ROOT: "/srv/out",
    MEDITATION_BGM_ROOT: "/srv/bgm",
    MEDITATION_VIDEO_ROOT: "/srv/video",
    AGNES_PROJECT_ROOT: "/srv/agnes",
    MEDITATION_SKILL_ROOTS: "/srv/skills"
  });
  assert.deepEqual(localOnlyPaths(config), []);
});

test("全角逗号、顿号、空格都要能切开 —— 中文输入法的默认是全角", () => {
  // 全角逗号切不开会把整串当成一把 key，请求 401，报错只说「无效的令牌」，
  // 完全看不出是分隔符的问题。这个坑不该让填 secret 的人去躲。
  const expected = ["sk-aaa", "sk-bbb", "sk-ccc"];
  for (const raw of [
    "sk-aaa,sk-bbb,sk-ccc",
    "sk-aaa，sk-bbb，sk-ccc",
    "sk-aaa， sk-bbb， sk-ccc",
    "sk-aaa、sk-bbb、sk-ccc",
    "sk-aaa\nsk-bbb\nsk-ccc",
    "  sk-aaa ;sk-bbb；sk-ccc  "
  ]) {
    const out = applyEnvOverrides(base(), { AGNES_API_KEYS: raw }).config.agnesHeadless.apiKeys;
    assert.deepEqual(out, expected, `切不开：${JSON.stringify(raw)}`);
  }
});

test("评委和运动导演的变量名是 SENSENOVA 开头 —— 它们本来就是 SenseNova", () => {
  const out = applyEnvOverrides(base(), {
    SENSENOVA_SCORER_KEYS: "sk-s1,sk-s2",
    SENSENOVA_MOTION_KEYS: "sk-m1"
  }).config;
  assert.deepEqual(out.agnesHeadless.scorerKeys, ["sk-s1", "sk-s2"]);
  assert.deepEqual(out.agnesHeadless.motionKeys, ["sk-m1"]);
});

test("没有 config.json 时，default-config 必须是能直接跑的完整配置", async () => {
  // CI 上 data/config.json 被 gitignore，不存在。这份默认配置就是全部依据。
  // 之前它是个骨架（model 空、baseUrl 指向 openai、engine 是 codex-cli），
  // 结果第一次跑 Actions 在选题那步就报「没有找到 Codex CLI」。
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(new URL("../data/default-config.json", import.meta.url), "utf8"));
  const { config } = applyEnvOverrides(raw, {});

  assert.equal(config.textEngine.mode, "api", "CI 上没有 Codex CLI，模式必须是 api");
  assert.ok(config.textProvider.model, "模型名不能为空");
  assert.ok(/deepseek/.test(config.textProvider.baseUrl), "地址应指向实际在用的供应商");
  // Skill 要用名字绑定，id 是绝对路径的哈希，换机器必然对不上
  for (const [slot, value] of Object.entries(config.slots)) {
    assert.ok(value && !/^[0-9a-f]{16}$/.test(value), `${slot} 应该用名字绑定而不是 id：${value}`);
  }
  // 路径要全是仓库内的相对路径
  for (const p of [config.app.outputRoot, config.media.bgmRoot, config.media.videoRoot]) {
    assert.ok(!p.startsWith("/"), `不该是绝对路径：${p}`);
  }
});

test("文本引擎三项可以被环境变量覆盖", () => {
  const out = applyEnvOverrides(base(), {
    TEXT_ENGINE_MODE: "api",
    TEXT_BASE_URL: "https://example.test/v1/chat/completions",
    TEXT_MODEL: "some-model"
  }).config;
  assert.equal(out.textEngine.mode, "api");
  assert.equal(out.textProvider.baseUrl, "https://example.test/v1/chat/completions");
  assert.equal(out.textProvider.model, "some-model");
});
