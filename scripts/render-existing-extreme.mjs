import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { callTextEngine, synthesizeMinimax } from "../src/providers.mjs";
import { analyzeTtsPacing, sanitizeTtsText, ttsPacingNeedsRetry } from "../src/workflow.mjs";
import { renderMedia, selectDatedAsset } from "../src/media.mjs";
import { resolveSlots } from "../src/skills.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const date = process.argv[2] || "2026-07-20";
const sourceName = process.argv[3] || "雪松山谷的温泉石窟";
const sourceDir = path.join("/Users/shareit/Desktop/output", date, sourceName);
const outputName = `${sourceName}-极限滞后版`;
const outputDir = path.join("/Users/shareit/Desktop/output", date, outputName);
const textDir = path.join(outputDir, "文本");
const audioDir = path.join(outputDir, "音频");
const videoDir = path.join(outputDir, "视频");
const manifestDir = path.join(outputDir, "清单");

const config = JSON.parse(await readFile(path.join(projectRoot, "data/config.json"), "utf8"));
const slots = await resolveSlots(config);
if (slots.ttsOptimizer?.name !== "minimax-meditation-tts-extreme-immersion") {
  throw new Error("当前配音优化槽位不是 MiniMax 极限滞后 Skill");
}

const [topic, script] = await Promise.all([
  readFile(path.join(sourceDir, "文本/01-选题结果.txt"), "utf8"),
  readFile(path.join(sourceDir, "文本/02-催眠冥想原稿.txt"), "utf8")
]);
await Promise.all([mkdir(textDir, { recursive: true }), mkdir(audioDir, { recursive: true }), mkdir(videoDir, { recursive: true }), mkdir(manifestDir, { recursive: true })]);
await Promise.all([
  writeFile(path.join(textDir, "01-选题结果.txt"), topic, "utf8"),
  writeFile(path.join(textDir, "02-催眠冥想原稿.txt"), script, "utf8")
]);

const runtime = `${slots.ttsOptimizer.content}\n\n# 本地工作台输出约定\n只输出加工后的 MiniMax TTS 纯文本。保留原稿内容和夜间结尾，不设成品时长目标，不因篇幅较长而缩短停顿。最终一句末尾不要放停顿标签。`;
console.log("[1/5] 正在按极限滞后 Skill 优化整篇人声文本…");
const generated = await callTextEngine(
  config,
  null,
  runtime,
  `请把下面的夜间助眠原稿加工成可直接放入 MiniMax text 字段的极限滞后版纯文本：\n\n${script}`,
  { mode: "codex-cli" }
);
const optimized = sanitizeTtsText(generated.text)
  .replace(/^```(?:text)?\s*/i, "")
  .replace(/\s*```$/, "")
  .trim();
const pacing = analyzeTtsPacing(optimized);
const missed = [...optimized.matchAll(/[，；：。！？](?!<#\d+(?:\.\d+)?#>)(?=[\s\S]*[\p{L}\p{N}])/gu)].length;
const consecutive = /<#\d+(?:\.\d+)?#>\s*<#\d+(?:\.\d+)?#>/.test(optimized);
const englishActions = /\(\s*(?:inhale|exhale|breath|sighs?|humming)\s*\)/i.test(optimized);
if (ttsPacingNeedsRetry(pacing, "extreme") || missed || consecutive || englishActions) {
  throw new Error(`极限滞后文本质检未通过：每百字停顿 ${pacing.pauseSecondsPer100Chars} 秒，漏标 ${missed}，连续标签 ${consecutive ? 1 : 0}，英文动作 ${englishActions ? 1 : 0}`);
}
const optimizedPath = path.join(textDir, "03-MiniMax极限滞后配音文本.txt");
await writeFile(optimizedPath, optimized, "utf8");
console.log(`[质检通过] 正文 ${pacing.spokenChars} 字 · ${pacing.pauseCount} 个停顿 · 每百字 ${pacing.pauseSecondsPer100Chars} 秒`);

console.log("[2/5] MiniMax 正在生成人声…");
const voice = await synthesizeMinimax(config, optimized);
const voicePath = path.join(audioDir, "AI原始人声-极限滞后版.mp3");
await writeFile(voicePath, voice.buffer);

console.log("[3/5] 正在选择本地背景音乐与视频素材…");
const [bgmPath, videoPath] = await Promise.all([
  selectDatedAsset(config.media.bgmRoot, date, [".mp3", ".wav", ".m4a", ".aac"]),
  selectDatedAsset(config.media.videoRoot, date, [".mp4", ".mov", ".m4v", ".webm"])
]);
const outputAudio = path.join(audioDir, `${outputName}.mp3`);
const outputVideo = path.join(videoDir, `${outputName}.mp4`);
console.log("[4/5] 正在混合人声与背景音乐…");
let lastAudioBucket = -1;
let lastVideoBucket = -1;
const media = await renderMedia(config, {
  voicePath,
  bgmPath,
  videoPath,
  outputAudio,
  outputVideo,
  onAudioProgress(value) {
    const bucket = Math.floor(value * 10);
    if (bucket !== lastAudioBucket) {
      lastAudioBucket = bucket;
      console.log(`[音频] ${Math.min(100, bucket * 10)}%`);
    }
  },
  onVideoProgress(value) {
    const bucket = Math.floor(value * 10);
    if (bucket !== lastVideoBucket) {
      lastVideoBucket = bucket;
      console.log(`[视频] ${Math.min(100, bucket * 10)}%`);
    }
  }
});

console.log("[5/5] 正在整理文件清单…");
const manifest = {
  createdAt: new Date().toISOString(),
  sourceDir,
  outputDir,
  skill: { name: slots.ttsOptimizer.name, version: slots.ttsOptimizer.version, file: slots.ttsOptimizer.file },
  textEngine: { engine: generated.engine, model: generated.model, reasoningEffort: generated.reasoningEffort },
  minimax: { model: config.minimax.model, voiceId: config.minimax.voiceId, speed: config.minimax.speed, emotion: config.minimax.emotion },
  mix: { bgmGainDb: config.media.bgmGainDb, bgmPath, videoPath, profile: media.videoProfile },
  pacing,
  qa: { missedPauseTags: missed, consecutivePauseTags: consecutive, englishActions },
  outputs: {
    optimizedText: optimizedPath,
    rawVoice: voicePath,
    mixedAudio: outputAudio,
    video: outputVideo,
    durationSeconds: media.totalDuration,
    audioBytes: (await stat(outputAudio)).size,
    videoBytes: (await stat(outputVideo)).size
  }
};
const manifestPath = path.join(manifestDir, `${outputName}.json`);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await copyFile(slots.ttsOptimizer.file, path.join(manifestDir, "本次使用的Skill.md"));
console.log(`RESULT_JSON=${JSON.stringify({ ...manifest.outputs, manifest: manifestPath, outputDir, pacing })}`);
