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
