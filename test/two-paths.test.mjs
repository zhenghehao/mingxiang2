import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const src = await readFile(new URL("../src/workflow.mjs", import.meta.url), "utf8");

// 这个文件专收「同一件事有两条实现，只改了一条」的毛病。
// 2026-08-18 一天之内撞到三次：
//   1. callTextProvider —— 老路径不认 key 池，选题这步悄悄绕过去，报 Forbidden；
//   2. renderVideoVariants —— 整跑出 5 条、续跑出 1 条（更早已修，靠抽出共用函数）；
//   3. startAgnesVisualTask —— 续跑那条传 null 当 progress，Agnes 的失败细节全丢，
//      5 条候选变 2 条却查不出在哪一步没的。
// 共同点是：两条路径都能跑通，只是行为不同，而且**不报错**，所以没人会发现。

test("Agnes 视觉任务的每一个调用都必须传 progress，不能传 null", () => {
  const calls = [...src.matchAll(/startAgnesVisualTask\(([^)]*)\)/g)]
    .map((m) => m[1])
    .filter((args) => !args.includes("config, text, title"));   // 排除函数定义本身
  assert.ok(calls.length >= 2, "应该有整跑和续跑两个调用点");
  for (const args of calls) {
    const 第四个参数 = args.split(",")[3]?.trim();
    assert.notEqual(第四个参数, "null",
      `有调用点把 progress 传成了 null，Agnes 的失败细节会被丢掉：startAgnesVisualTask(${args})`);
  }
});

test("文本请求只有一条路径 —— callTextProvider 不该再被调用", () => {
  const providers = src.replace(/\/\*[\s\S]*?\*\//g, "");   // 去掉块注释再找
  assert.doesNotMatch(providers, /await\s+callTextProvider\s*\(/,
    "callTextProvider 是不认 key 池的老路径，已废弃；统一走 callCustomTextProvider");
});

test("整跑和续跑用的是同一个导出函数，不是各写一份", () => {
  const 次数 = (src.match(/renderVideoVariants\(/g) || []).length;
  assert.ok(次数 >= 3, `renderVideoVariants 应当被定义一次、调用两次（实际出现 ${次数} 次）`);
});

// ── 断线要能重试 ────────────────────────────────────────────────
import { isTransientTextError } from "../src/workflow.mjs";

test("连接类失败一律判为可重试，包括读响应体时断掉的", () => {
  // 2026-08-18 云端 #217：写稿跑到第 3.3 分钟抛了一个光秃秃的 "terminated"
  //（Node fetch 在响应流被对端掐断时的原话）。它不在清单里 → 不重试 → 整轮报废。
  // 写稿动辄几分钟，中途断线是常态，不该让一次抖动毁掉一整轮。
  for (const m of [
    "terminated",
    "无法连接接口：读取响应中断（terminated）",
    "TypeError: terminated",
    "other side closed",
    "socket hang up",
    "fetch failed",
    "接口请求超时，请检查地址、网络或模型状态"
  ]) {
    assert.ok(isTransientTextError(new Error(m)), `「${m}」应当重试`);
  }
});

test("配置类错误仍然不重试 —— 重发一万次也是同样的错", () => {
  for (const m of [
    "接口请求失败（401）：invalid api key",
    "请填写模型名称",
    "接口已响应，但没有找到文本内容；可在高级设置中填写响应路径",
    "接口地址格式不正确"
  ]) {
    assert.equal(isTransientTextError(new Error(m)), false, `「${m}」不该重试`);
  }
});

test("读响应体被包在 try 里 —— 裸奔的异常上层认不出来", async () => {
  const { readFile } = await import("node:fs/promises");
  const p = await readFile(new URL("../src/providers.mjs", import.meta.url), "utf8");
  const seg = p.slice(p.indexOf("callCustomTextProvider"), p.indexOf("const configured"));
  assert.doesNotMatch(seg, /\n  const raw = await response\.text\(\);/,
    "response.text() 不能裸奔在 try 外面");
  assert.match(seg, /try \{\s*raw = await response\.text\(\);/);
});
