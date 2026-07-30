import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// buildStageProviders 没导出（它是 workflow 的内部实现），从源码里抠出来单测。
// 这段逻辑值得测：配错了不会报错，只会**静默用错模型**跑完整条流水线。
const src = await readFile(new URL("../src/workflow.mjs", import.meta.url), "utf8");
const body = src.slice(
  src.indexOf("function buildStageProviders"),
  src.indexOf("export async function runTextWorkflow")
);
const buildStageProviders = new Function(`${body}; return buildStageProviders;`)();

const base = (stageModels) => ({
  textProvider: {
    baseUrl: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-pro",
    temperature: 0.7,
    ...(stageModels ? { stageModels } : {})
  }
});

test("没配 stageModels 时返回空 —— 行为必须和以前完全一样", () => {
  assert.deepEqual(buildStageProviders(base()), {});
  assert.deepEqual(buildStageProviders({}), {});
  assert.deepEqual(buildStageProviders(undefined), {});
});

test("只给指定的步骤建 provider，其余落回默认", () => {
  const out = buildStageProviders(base({ topic: "deepseek-v4-flash", script: "", tts: "", copy: "deepseek-v4-flash" }));
  assert.deepEqual(Object.keys(out).sort(), ["copy", "topic"]);
  assert.equal(out.topic.model, "deepseek-v4-flash");
  assert.equal(out.copy.model, "deepseek-v4-flash");
});

test("空字符串是「不特殊指定」，不能变成空模型名发出去", () => {
  // 拿空模型名请求会 400，而且报错看不出是配置写空了
  const out = buildStageProviders(base({ script: "", tts: "   " }));
  assert.deepEqual(out, {});
});

test("和默认模型同名时也不建 provider —— 白绕一圈没意义", () => {
  assert.deepEqual(buildStageProviders(base({ script: "deepseek-v4-pro" })), {});
});

test("继承 baseUrl、温度和鉴权方式，只换模型名", () => {
  const config = base({ topic: "deepseek-v4-flash" });
  config.textProvider.authHeader = "X-Key";
  config.textProvider.authPrefix = "";
  const out = buildStageProviders(config);
  assert.equal(out.topic.endpoint, "https://api.deepseek.com/chat/completions");
  assert.equal(out.topic.temperature, 0.7);
  assert.equal(out.topic.authHeader, "X-Key");
  assert.equal(out.topic.authPrefix, "");
});

test("实际配置文件里的分工就是 02/03 用 pro、01/04 用 flash", async () => {
  const config = JSON.parse(await readFile(new URL("../data/config.json", import.meta.url), "utf8"));
  const out = buildStageProviders(config);
  assert.equal(out.topic?.model, "deepseek-v4-flash", "01 选题应该用 flash");
  assert.equal(out.copy?.model, "deepseek-v4-flash", "04 发布文案应该用 flash");
  assert.equal(out.script, undefined, "02 原稿应该落回默认的 pro");
  assert.equal(out.tts, undefined, "03 配音文本应该落回默认的 pro");
  assert.equal(config.textProvider.model, "deepseek-v4-pro");
});
