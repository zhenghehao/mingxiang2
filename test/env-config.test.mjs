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
