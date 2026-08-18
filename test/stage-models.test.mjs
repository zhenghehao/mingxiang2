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
// 切片里可能夹着别的顶层声明，其中 `export` 在 new Function 里是语法错误
// （2026-08-18 就这么炸过一次：往这两个锚点中间加了一个 export function）。
// 去掉 export 关键字即可 —— 这里只要那些函数的**函数体**，导不导出无所谓。
const buildStageProviders = new Function(`${body.replace(/^export\s+/gm, "")}; return buildStageProviders;`)();

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

test("实际生效的分工是四步全用 flash", async (t) => {
  // 量的是**合并后**的配置（default-config ← config.json），因为那才是真正跑的东西。
  //
  // 原来这条只读 config.json，于是有两个毛病：新克隆和 CI 上没这个文件就整条跳过，
  // 白白失去保护；而本机一旦存在一份只写了局部覆盖的 config.json（比如只改端口），
  // 它又会拿这份残缺配置去查 textProvider，查不到就报假失败。
  const defaults = JSON.parse(await readFile(new URL("../data/default-config.json", import.meta.url), "utf8"));
  const user = await readFile(new URL("../data/config.json", import.meta.url), "utf8")
    .then(JSON.parse).catch(() => ({}));
  const { deepMerge } = await import("../src/json-store.mjs");
  const config = deepMerge(defaults, user);

  const out = buildStageProviders(config);

  // 量的是**这一步最终会用哪个模型**，不是「buildStageProviders 有没有给它建 provider」。
  // 两者会不一样：分步模型和默认模型同名时 buildStageProviders 故意不建（白绕一圈），
  // 那一步落回 config.textProvider.model —— 结果仍然正确。
  // 2026-08-18 的配置正好踩中这一点：topic 和默认 model 都是 sensenova-6.8-flash-lite。
  const 实际用的 = (stage) => out[stage]?.model || config.textProvider.model;
  // 分成两个断言，因为这是两件事：
  //
  //   「仓库里发出去的默认配置」—— 只看 default-config，CI 和新克隆跑的就是它，
  //     必须钉死，改模型时这条会红，逼人回来确认新模型名在那个网关上真的存在。
  //   「本机实际跑的」—— 合并后的配置。本机 config.json **本来就允许**指到别处
  //     （2026-08-18 本机在试 SenseNova + glm-5.2，而仓库默认仍是 DeepSeek），
  //     所以这一层只能查「每一步都有模型名」，不能钉具体是哪个。
  //
  // 原来两件事混在一条断言里：本机一改模型，测试就红，而红的不是 bug 是配置差异。
  const 发出去的 = buildStageProviders(defaults);
  for (const stage of ["topic", "script", "tts", "copy"]) {
    assert.equal(发出去的[stage]?.model || defaults.textProvider.model, "deepseek-v4-flash",
      `default-config 里 ${stage} 应该是 deepseek-v4-flash`);
  }
  for (const stage of ["topic", "script", "tts", "copy"]) {
    assert.ok(实际用的(stage), `${stage} 没有模型名 —— 合并后的配置不完整`);
  }

  // 分步覆盖只该换模型名：端点仍是同一个，密钥压根不在这一层。
  for (const stage of ["topic", "script", "tts", "copy"]) {
    if (!out[stage]) continue;   // 没建 provider 的那步用的就是全局端点，无从跑偏
    assert.equal(out[stage].endpoint, config.textProvider.baseUrl, `${stage} 不该改端点`);
  }

  // key 池必须传到每一个建出来的 provider 上，否则那一步换不了 key。
  // 池子只在 config.json 里（进不了仓库），CI 上为空，所以只在有池时断言。
  if ((config.textProvider.apiKeys || []).length) {
    for (const stage of ["topic", "script", "tts", "copy"]) {
      if (!out[stage]) continue;
      assert.equal(out[stage].apiKeys?.length, config.textProvider.apiKeys.length,
        `${stage} 没拿到完整的 key 池`);
    }
  }
});
