#!/usr/bin/env node
/**
 * 命令行跑一次完整流水线。
 *
 * 界面版（server.mjs）要人点按钮，CI 里没人点，所以要有这个入口。
 * 它和界面走的是同一个 runAll —— 不是另写一条流水线，否则两边迟早漂移。
 *
 *   node scripts/run-once.mjs --date 2026-07-30 --brief 晚上 --minutes 10
 *
 * 配置来源和界面一致：default-config.json ← config.json ← 环境变量，
 * 后面的覆盖前面的。CI 上没有 config.json，全靠环境变量（见 .env.example）。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deepMerge, readJson } from "../src/json-store.mjs";
import { applyEnvOverrides, localOnlyPaths } from "../src/env-config.mjs";
import { runAll, DEFAULT_DURATION_MINUTES } from "../src/workflow.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1].trim() : fallback;
}

const defaults = JSON.parse(await readFile(path.join(ROOT, "data/default-config.json"), "utf8"));
const user = await readJson(path.join(ROOT, "data/config.json"), {});
const { config, applied } = applyEnvOverrides(deepMerge(defaults, user));

const date = arg("date") || new Date().toLocaleDateString("en-CA");
const brief = arg("brief", "晚上");
const minutes = Number(arg("minutes", String(DEFAULT_DURATION_MINUTES))) || DEFAULT_DURATION_MINUTES;

console.log(`日期 ${date} · 时段 ${brief} · 目标 ${minutes} 分钟`);
console.log(`文本模型 ${config.textProvider.model} @ ${new URL(config.textProvider.baseUrl).host}`);
const stage = config.textProvider.stageModels || {};
const overridden = Object.entries(stage).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
if (overridden.length) console.log(`分步覆盖 ${overridden.join(" ")}`);
console.log(`环境变量生效 ${applied.length} 项`);

// 缺密钥要在开跑前就说。跑到第 8 分钟才因为没配 SENSENOVA 而失败，
// 前面的模型调用和 MiniMax 额度就白花了。
const required = [
  ["TEXT_API_KEY", "文本（选题/原稿/配音文本/发布文案）"],
  ["SENSENOVA_API_KEYS", "封面图"],
  ["AGNES_API_KEYS", "Agnes 视觉"]
];
const missing = required.filter(([name]) => !process.env[name]).map(([name, use]) => `${name}（${use}）`);
const minimaxMode = config.minimax.deliveryMode === "subscription"
  ? "MINIMAX_SUBSCRIPTION_KEY" : "MINIMAX_API_KEY";
if (!process.env[minimaxMode]) missing.push(`${minimaxMode}（AI 人声）`);
if (missing.length) {
  console.error(`\n缺这些环境变量，跑不起来：\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

const stillLocal = localOnlyPaths(config);
if (stillLocal.length) {
  console.warn(`\n注意：${stillLocal.length} 处还指向本机路径，在别的机器上会找不到：`);
  for (const item of stillLocal) console.warn(`  ${item.path} → 用 ${item.env} 覆盖`);
}

const started = Date.now();
let lastLine = "";
try {
  const manifest = await runAll(config, {
    date,
    brief,
    outputName: "",
    durationMinutes: minutes
  }, ROOT, {
    onProgress: (event) => {
      const line = `[${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s ${String(event.progress || 0).padStart(3)}%] ${event.step} · ${event.message}`;
      if (line === lastLine) return;
      lastLine = line;
      console.log(line);
    }
  });
  console.log(`\n完成，用时 ${((Date.now() - started) / 60000).toFixed(1)} 分钟`);
  console.log(`  选题   ${manifest.title}`);
  console.log(`  音频   ${manifest.media?.outputAudio || "—"}`);
  console.log(`  视频   ${manifest.media?.outputVideo || "—"}`);
  console.log(`  封面   ${(manifest.cover?.archived || []).length} 张`);
  console.log(`  文案   ${manifest.assets?.copyTxtPath || "—"}`);
} catch (error) {
  console.error(`\n失败于第 ${((Date.now() - started) / 60000).toFixed(1)} 分钟：${error.message}`);
  process.exitCode = 1;
}
