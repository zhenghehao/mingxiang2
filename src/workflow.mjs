import { access, copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  agnesEndFadeSeconds,
  agnesFallbackEnabled,
  agnesVisualsEnabled,
  generateAgnesVisuals
} from "./agnes.mjs";
import { agnesHeadlessEnabled, generateAgnesVisualsHeadless } from "./agnes-headless.mjs";
import { callTextEngine, synthesizeMinimax } from "./providers.mjs";
import { resolveSlots } from "./skills.mjs";
import {
  CancelledError, probeDuration, renderAudio, renderVideo, resolveMediaBinary, resolveVideoProfile, selectDatedAsset
} from "./media.mjs";
import { readJson, writeJson } from "./json-store.mjs";
import { extractTopicRecord, findDuplicateTopic, formatTopicHistory, loadTopicHistory, recordTopic } from "./topic-history.mjs";
import { generateCovers, BILIBILI_DIR, COVER_SPECS } from "./cover.mjs";
import { buildPlatformCopyList, renderPlatformCopyTxt } from "./draft-publisher.mjs";

const SLOT_LABELS = {
  topic: "选题",
  script: "催眠冥想文稿",
  ttsOptimizer: "MiniMax 标记优化",
  copywriter: "平台文案"
};

function safeName(value) {
  return String(value || "meditation").replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "meditation";
}

const TTS_ACTION_WORDS = {
  inhale: "轻轻吸气",
  exhale: "缓缓呼气",
  breath: "自然换气",
  sigh: "轻轻叹一口气",
  sighs: "轻轻叹一口气",
  humming: "轻声哼唱"
};

export function sanitizeTtsText(value) {
  return String(value || "").replace(
    /\(\s*(inhale|exhale|breath|sighs?|humming)\s*\)/gi,
    (_, action) => TTS_ACTION_WORDS[action.toLowerCase()]
  );
}

export function analyzeTtsPacing(value) {
  const text = String(value || "");
  const pauses = [...text.matchAll(/<#(\d+(?:\.\d+)?)#>/g)].map((match) => Number(match[1]));
  const spokenChars = (text.replace(/<#\d+(?:\.\d+)?#>/g, "").match(/[\p{L}\p{N}]/gu) || []).length;
  const pauseSeconds = pauses.reduce((total, seconds) => total + seconds, 0);
  return {
    spokenChars,
    pauseCount: pauses.length,
    pauseSeconds: Number(pauseSeconds.toFixed(2)),
    pauseSecondsPer100Chars: spokenChars ? Number((pauseSeconds / spokenChars * 100).toFixed(2)) : 0,
    longPauseCount: pauses.filter((seconds) => seconds >= 2.5).length
  };
}

function countHanCharacters(value) {
  return (String(value || "").match(/\p{Script=Han}/gu) || []).length;
}

export function ttsPacingNeedsRetry(stats, mode = "natural") {
  if (!stats || stats.spokenChars < 800) return false;
  if (mode === "extreme") return stats.pauseSecondsPer100Chars < 15 || stats.pauseSecondsPer100Chars > 90;
  return stats.pauseSecondsPer100Chars < 7 || stats.pauseSecondsPer100Chars > 13;
}

/** 不填时长时按这个走。 */
export const DEFAULT_DURATION_MINUTES = 10;

/** 封面这一步的总闸。内部单个请求各有 timeout，但没有总时长上限。 */
export const COVER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 「重跑某一步」的依赖表 —— 整个重跑功能的唯一真相。
 *
 * 每一项声明：重跑这一步时，**文本阶段**要重新调用哪些 Skill、**媒体阶段**要
 * 重做哪些环节。没列出来的一律从上次的落盘产物里复用，不重新花钱、不重新等。
 *
 * 表是按「谁的输出喂给谁」推出来的，不是凭感觉排的：
 *   选题 → 原稿          原稿 → 配音文本、Agnes 画面（Agnes 读的是 text.script）
 *   配音文本 → 人声、发布文案     人声 → 混音     混音 → 视频渲染
 *   Agnes 画面 → 视频渲染         视频 → 整理 → 发布
 *
 * 注意 media 里 `visuals`（Agnes 生成画面，20–40 分钟）和 `video`（ffmpeg 把画面
 * 和音频合成导出，几分钟）是**两件事**，必须分开列。混音一改，视频得重新导出
 * （时长变了），但 Agnes 那两段素材还能用 —— 要是把它们当成一件事，用户「换首
 * BGM」就要陪着等 40 分钟的画面重跑，这是最容易搞错也最气人的地方。
 * 反过来 `tts` 只动配音文本、不动 script，所以 Agnes 也不用重跑。
 *
 * 另外：
 *   - 发布文案（copy）和封面（cover）是**叶子**，只喂给发布，重跑它们完全不用动
 *     人声、混音、视频 —— 这正是用户要的「不涉及前后交接的下面步骤不用重新跑」。
 *   - 反过来，配音文本一改，人声就必须重合成，否则音频和文本对不上，成品是错的。
 *     这种「上下有交接」的必须连带重做。
 *   - `files`（写清单、整理成品目录）在 runAll 里是无条件执行的，列在这儿只为
 *     把「这一档会让清单变化」写清楚。
 *
 * ⚠️ 改这张表就等于改行为，务必连带更新 public/app.js 的 RERUN_HINT 文案，
 *    否则界面会向用户承诺一件后端不会做的事。
 */
export const RERUN_PLAN = {
  topic:  { text: ["topic", "script", "tts", "copy"], media: ["cover", "voice", "audio", "visuals", "video", "files"] },
  script: { text: ["script", "tts", "copy"],          media: ["voice", "audio", "visuals", "video", "files"] },
  tts:    { text: ["tts", "copy"],                    media: ["voice", "audio", "video", "files"] },
  copy:   { text: ["copy"],                           media: ["files"] },
  cover:  { text: [],                                 media: ["cover", "files"] },
  voice:  { text: [],                                 media: ["voice", "audio", "video", "files"] },
  audio:  { text: [],                                 media: ["audio", "video", "files"] },
  video:  { text: [],                                 media: ["visuals", "video", "files"] },
  files:  { text: [],                                 media: ["files"] },
  publish:{ text: [],                                 media: [] }
};

/** 给一个 Promise 加超时。超时只是让调用方能继续走，底层请求该怎么结束还怎么结束。 */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]).finally(() => clearTimeout(timer));
}

/**
 * 由目标分钟数推算正文中文字数标尺。
 *
 * 系数来自三个真机校准点的线性拟合：
 *   10 分钟 → 534 字 ／ 15 分钟 → 778 字 ／ 20 分钟 → 1021 字
 * 拟合出「字数 ≈ 48.7 × 分钟 + 47」，三个点都能对上。
 *
 * 上下浮动取 ±12%：用户要的是「10 分钟左右」而不是卡死到秒，
 * 留余量让文稿自然收尾，而不是为了凑字数硬截断。
 */
export function resolveDurationPlan(minutes) {
  const raw = Number(minutes);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const clamped = Math.min(60, Math.max(3, Math.round(raw)));
  const targetChars = Math.round(48.7 * clamped + 47);
  const band = Math.round(targetChars * 0.12);
  return {
    minutes: clamped,
    targetChars,
    minChars: targetChars - band,
    maxChars: targetChars + band,
    flexible: true
  };
}

export function resolveExtremeDurationPlan(brief, skillName = "") {
  if (skillName !== "minimax-meditation-tts-extreme-immersion") return null;
  const value = String(brief || "");
  if (/(?:20|二十)\s*分钟/.test(value)) return { minutes: 20, targetChars: 1021, minChars: 1000, maxChars: 1050 };
  if (/(?:15|十五)\s*分钟/.test(value)) return { minutes: 15, targetChars: 778, minChars: 760, maxChars: 800 };
  if (/(?:10|(?<!二)十)\s*分钟/.test(value) && /左右|大约|约|不必卡死|自然完整优先/.test(value)) {
    return { minutes: 10, targetChars: 534, minChars: 460, maxChars: 620, flexible: true };
  }
  if (/(?:10|(?<!二)十)\s*分钟/.test(value)) return { minutes: 10, targetChars: 534, minChars: 520, maxChars: 550 };
  return null;
}

/**
 * 从发布文案里清掉时长表述。
 *
 * 为什么代码里还要再兜一道：发布文案在**文稿阶段**生成，那时人声没合成、
 * BGM 和片尾渐弱也没加，**最终时长根本还不存在**。实测一份「7 分钟」的文稿
 * 成品是 14 分钟 —— 写进标题就是当众写错。
 * Skill 里已经明令禁止，但那是提示词约束，模型仍可能漏；这里做确定性兜底。
 */
export function stripDurationFromCopy(node) {
  const clean = (s) => String(s)
    .replace(/[（(]\s*(?:约|大约|全程约)?\s*\d+\s*分钟\s*[)）]/g, "")   // （7分钟）
    .replace(/(?:全程|时长)?\s*(?:约|大约)?\s*\d+\s*分钟(?:左右)?/g, "")  // 全程约7分钟
    .replace(/\s{2,}/g, " ")
    .replace(/[，,。]\s*(?=[，,。])/g, "")
    .trim();

  if (typeof node === "string") return clean(node);
  if (Array.isArray(node)) return node.map(stripDurationFromCopy);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      // duration_minutes 之类的内部字段保留原值，只清面向平台的文本
      out[k] = /duration|minutes/i.test(k) ? v : stripDurationFromCopy(v);
    }
    return out;
  }
  return node;
}

function parseCopyPackage(value) {
  const raw = String(value || "").trim();
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    return {
      schema_version: "unparsed",
      raw_text: raw,
      parse_error: `文案 Skill 未返回合法 JSON：${error.message}`
    };
  }
}

export function formatPublishingContext() {
  // 使用本地发布工具的目标平台列表
  const platforms = ["抖音", "快手", "小红书", "B站", "视频号", "喜马拉雅", "网易云播客"];
  return [
    `目标发布平台：${platforms.join("、")}`,
    "为以上所有平台生成适配的标题和文案版本。",
    "注意各平台标题长度限制：小红书≤20字，网易云6-16字，喜马拉雅≤40字，抖音≤55字，B站≤80字。",
    "快手和视频号无独立标题框，标题写入描述第一行。"
  ].join("\n");
}

async function publishingContext(config) {
  return formatPublishingContext();
}

async function writeTextPackage(text, textDir, { runId = "", title = "" } = {}) {
  await mkdir(textDir, { recursive: true });
  // 04 同时写 json 和 txt。
  //
  // json 是给程序读的，txt 是给人抄的 —— 发布时要逐个平台复制标题和简介，
  // 对着 JSON 抄很难受。txt 以前只在打开发布面板时才生成、而且写在 work/runs
  // 工作目录里，等于成品目录里根本没有；现在它和音频视频封面一样是成品的固有部分。
  let copyTxt = "";
  try {
    copyTxt = renderPlatformCopyTxt({
      title: title || runId,
      runId,
      createdAt: new Date().toISOString(),
      platforms: buildPlatformCopyList(text)
    });
  } catch (error) {
    // 文案缺失或结构异常时不该拖垮整个归档 —— json 照样写，txt 留个说明
    copyTxt = `这次没能生成可读版文案：${error.message}\n请看同目录的 04-跨平台发布文案.json`;
  }
  await Promise.all([
    writeJson(path.join(textDir, "文本完整记录.json"), text),
    writeFile(path.join(textDir, "01-选题结果.txt"), String(text.topic || ""), "utf8"),
    writeFile(path.join(textDir, "02-催眠冥想原稿.txt"), String(text.script || ""), "utf8"),
    writeFile(path.join(textDir, "03-MiniMax最终配音文本.txt"), String(text.optimized || ""), "utf8"),
    writeJson(path.join(textDir, "04-跨平台发布文案.json"), text.copy || null),
    writeFile(path.join(textDir, "04-跨平台发布文案.txt"), copyTxt, "utf8")
  ]);
}

async function obtainVoice(config, optimizedText, runDir, audioDir, { progress, startProgress, doneProgress } = {}) {
  const modeLabel = config.minimax.deliveryMode === "subscription" ? "订阅 Key" : "普通 API";
  progress?.({ step: "voice", status: "running", progress: startProgress, message: `正在通过 MiniMax ${modeLabel}生成人声` });
  const speech = await synthesizeMinimax(config, optimizedText);
  const voicePath = path.join(runDir, `voice.${config.minimax.format}`);
  const savedVoicePath = path.join(audioDir, `AI原始人声.${config.minimax.format}`);
  await Promise.all([writeFile(voicePath, speech.buffer), writeFile(savedVoicePath, speech.buffer)]);
  progress?.({ step: "voice", status: "done", progress: doneProgress, message: "AI 人声已经生成", detail: savedVoicePath });
  return { speech, voicePath, savedVoicePath };
}

function startAgnesVisualTask(config, text, title, progress, signal) {
  // headless 版优先。它和浏览器版产出同样的结构，区别只在于不需要有人
  // 开着 agnes-playground 页面 —— 页面一关任务就没人认领的问题从根上消失。
  // 想退回浏览器版，把 config.agnesHeadless.enabled 改回 false 即可。
  const headless = agnesHeadlessEnabled(config);
  if (!headless && !agnesVisualsEnabled(config)) return null;
  progress?.({
    step: "video",
    status: "running",
    progress: 59,
    message: headless ? "正在把冥想文稿送入 Agnes 视觉流水线" : "正在把冥想文稿送入 Agnes 视觉工作流"
  });
  const run = headless ? generateAgnesVisualsHeadless : generateAgnesVisuals;
  return run(config, {
    article: text.script,
    title,
    signal,
    onProgress: (event) => {
      const visualProgress = Math.round(59 + Math.min(100, Number(event.progress || 0)) * 0.22);
      progress?.({
        step: "video",
        status: "running",
        progress: Math.min(81, visualProgress),
        message: event.message || "Agnes 正在生成冥想画面",
        detail: event.phase ? `Agnes · ${event.phase}` : "",
        agnesJobId: event.jobId || ""
      });
    }
  }).then((result) => ({ result, error: null })).catch((error) => ({ result: null, error }));
}

async function resolveVisualAssets(config, input, agnesTask, progress) {
  if (agnesTask) {
    const outcome = await agnesTask;
    if (outcome.result) {
      progress?.({
        step: "video",
        status: "running",
        progress: 82,
        message: "Agnes 已返回动态封面和纯净循环视频",
        detail: outcome.result.selectedTitle || ""
      });
      return {
        source: "agnes",
        introVideoPath: outcome.result.coverPath,
        loopVideoPath: outcome.result.loopPath,
        videoPath: null,
        agnes: outcome.result,
        warning: null
      };
    }
    if (!agnesFallbackEnabled(config)) throw outcome.error;
    progress?.({
      step: "video",
      status: "running",
      progress: 82,
      message: "Agnes 暂时不可用，正在回退到本地视频素材",
      detail: outcome.error?.message || ""
    });
    const videoPath = await selectDatedAsset(config.media.videoRoot, input.date, [".mp4", ".mov", ".mkv", ".webm"]);
    return {
      source: "library-fallback",
      introVideoPath: null,
      loopVideoPath: null,
      videoPath,
      agnes: null,
      warning: `Agnes 视觉工作流失败，已回退本地素材：${outcome.error?.message || "未知错误"}`
    };
  }
  const videoPath = await selectDatedAsset(config.media.videoRoot, input.date, [".mp4", ".mov", ".mkv", ".webm"]);
  return {
    source: "library",
    introVideoPath: null,
    loopVideoPath: null,
    videoPath,
    agnes: null,
    warning: null
  };
}

export async function composeWorkflow(config, brief) {
  const slots = await resolveSlots(config);
  return Object.entries(slots).filter(([, skill]) => skill).map(([slot, skill]) => ({
    slot,
    label: SLOT_LABELS[slot],
    skill: { id: skill.id, name: skill.name, version: skill.version, file: skill.file },
    instructions: skill.content,
    inputPreview: brief
  }));
}

/**
 * @param {function} [options.onPartial] - 每完成一个文本阶段就回调一次，参数是
 *   到目前为止的部分结果。用于**分步落盘**：原来 text.json 只在四步全部跑完后
 *   写一次，中途失败（比如文本接口 401）等于前面几步的产出全部丢失，
 *   续跑无从续起。
 */
/**
 * 文本四步（选题 → 原稿 → 配音文本 → 发布文案）。
 *
 * `stages` / `reuse` 是给「重跑某一步」用的：stages 里没列到的阶段直接从 reuse
 * （上次的 text.json）里取，一次模型都不调。stages 为 null 时是全新运行，四步全跑。
 * 例：只重跑发布文案 → stages=["copy"]，选题/原稿/配音文本全部原样复用。
 */
/**
 * 按 config.textProvider.stageModels 给四步各配一个 provider。
 *
 * 为什么要分步：这四步对模型的要求不一样。原稿和配音文本是创作，值得用贵的；
 * 选题只是从候选里挑一个、发布文案是套模板填字，便宜的模型够用。
 * 只写了模型名的步骤会继承 textProvider 的地址和鉴权方式，所以同一家的不同型号
 * 换起来只要填一个字符串。
 *
 * 没配 stageModels 时返回空对象 —— 行为和以前完全一样，四步共用 textProvider。
 */
function buildStageProviders(config) {
  const base = config?.textProvider || {};
  const stageModels = base.stageModels || {};
  const out = {};
  for (const [slot, model] of Object.entries(stageModels)) {
    const name = String(model || "").trim();
    // 空字符串表示「这一步不特殊指定」，落回默认，而不是拿空模型名去请求
    if (!name || name === base.model) continue;
    out[slot] = {
      endpoint: base.baseUrl,
      model: name,
      temperature: base.temperature,
      authHeader: base.authHeader,
      authPrefix: base.authPrefix
    };
  }
  return out;
}

export async function runTextWorkflow(config, input, { onProgress, onPartial, topicHistory = [], stages = null, reuse = null } = {}) {
  const want = (stage) => !stages || stages.includes(stage);
  const { brief, date } = input;
  // 四步可以各用各的模型：config.textProvider.stageModels 里给哪一步写了模型名，
  // 哪一步就单独走那个；没写的沿用 textProvider.model。
  // input.providers 优先级最高，留给以后在界面上临时覆盖。
  const providers = { ...buildStageProviders(config), ...(input.providers || {}) };
  const period = /中午|午休|午间/.test(String(brief || "")) ? "中午" : "晚上";
  const engineMode = String(input?.textEngine?.mode || config?.textEngine?.mode || "api");
  const slots = await resolveSlots(config);
  for (const required of ["topic", "script"]) {
    if (!slots[required]) throw new Error(`请先为“${SLOT_LABELS[required]}”绑定 Skill`);
  }
  // 时长优先用界面显式传入的分钟数；没传就按默认 10 分钟。
  // （旧逻辑只在绑定 extreme-immersion 这个 TTS Skill 时才生效，而且靠正则
  //   从 brief 自由文本里猜分钟数，换个 Skill 时长控制就整个失效了。）
  const durationPlan =
    resolveDurationPlan(input.durationMinutes ?? DEFAULT_DURATION_MINUTES)
    || resolveExtremeDurationPlan(brief, slots.ttsOptimizer?.name);
  const lengthPrinciple = durationPlan
    ? `目标成品约 ${durationPlan.minutes} 分钟：正文只统计中文字，以 ${durationPlan.targetChars} 字为中心，控制在 ${durationPlan.minChars}–${durationPlan.maxChars} 字；在范围内完成自然结构和结尾，不要机械截断或凑字。`
    : "结构完整、自然结束，不设字数或分钟目标";
  const topicRuntime = `${slots.topic.content}\n\n# 本地应用自动运行约定\n当前由无人值守工作流调用。不要向用户提问，也不要等待用户选择。应用已扫描本地选题库并在输入中提供完整禁用清单。必须先排除重复，再在内部生成至少 8 个候选并自动选择总分最高的一项。${durationPlan ? `本次成品目标时长约 ${durationPlan.minutes} 分钟，按应用提供的中文字数标尺规划结构。` : "文稿按结构自然完成，不接收成品时长目标。"}不得压缩内容或填充空话。最终严格按 Skill 的唯一输出格式返回一个结果。`;
  const runs = [];
  const progress = (event) => onProgress?.(event);
  const stageProgress = {
    topic: { start: 4, end: 14, startMessage: "正在确定本次冥想主题与方向", doneMessage: "选题已经确定" },
    script: { start: 15, end: 36, startMessage: "正在创作完整催眠冥想文稿", doneMessage: "冥想原稿已经完成" },
    tts: { start: 37, end: 48, startMessage: "正在优化停顿、语气与呼吸提示", doneMessage: "配音文本已经优化" },
    copy: { start: 49, end: 58, startMessage: "正在整理跨平台发布文案", doneMessage: "发布文案已经整理" }
  };
  const callStage = async (slot, instructions, stageInput, { complete = true } = {}) => {
    const stage = stageProgress[slot];
    progress({ step: slot, status: "running", progress: stage.start, message: stage.startMessage });
    const result = await callTextEngine(config, providers[slot], instructions, stageInput, { mode: engineMode });
    runs.push({
      stage: slot,
      engine: result.engine,
      model: result.model,
      reasoningEffort: result.reasoningEffort,
      elapsedMs: result.elapsedMs
    });
    if (complete) {
      progress({
        step: slot,
        status: "done",
        progress: stage.end,
        message: stage.doneMessage,
        detail: `${result.model || result.engine} · ${(result.elapsedMs / 1000).toFixed(1)} 秒`
      });
    }
    return result.text;
  };
  // 重跑时选题可能是复用的 —— 此时整个查重循环都不该跑（历史库里已经有它了，
  // 再查一次必然判自己重复）。
  let topic = want("topic") ? "" : String(reuse?.topic || "");
  let duplicate = null;
  const rejected = [];
  for (let attempt = 1; want("topic") && attempt <= 3; attempt += 1) {
    topic = await callStage("topic", topicRuntime, [
      `日期：${date}`,
      `时段：${period}`,
      `篇幅原则：${lengthPrinciple}`,
      "历史选题禁用清单：",
      formatTopicHistory(topicHistory),
      rejected.length ? `\n本次已被程序拒绝的候选：${rejected.join("、")}` : "",
      "请完成查重、内部候选评分和自动择优，只给出唯一结果。"
    ].filter(Boolean).join("\n"), { complete: false });
    const record = extractTopicRecord(topic);
    duplicate = findDuplicateTopic(record, topicHistory);
    if (record && !duplicate) break;
    rejected.push(record?.title || "无有效标题");
    progress({
      step: "topic",
      status: "running",
      progress: 10,
      message: duplicate ? `发现与“${duplicate.title}”重复，正在自动重新选题` : "选题格式不完整，正在自动重新生成"
    });
  }
  if (!extractTopicRecord(topic)) {
    throw new Error(want("topic")
      ? "自动选题连续三次缺少有效标题，请检查选题 Skill"
      : "上次的选题记录不完整，无法在复用选题的前提下重跑");
  }
  if (duplicate) throw new Error(`自动选题与历史题目“${duplicate.title}”重复，已停止生成`);
  const topicRun = runs.filter((run) => run.stage === "topic").at(-1);
  await onPartial?.({ topic, engineRuns: runs });
  progress({
    step: "topic",
    status: "done",
    progress: 14,
    message: want("topic")
      ? `已从候选中自动选出“${extractTopicRecord(topic).title}”`
      : `复用上次选题“${extractTopicRecord(topic).title}”`,
    detail: want("topic")
      ? `已检查 ${topicHistory.length} 个历史题目 · ${topicRun?.model || topicRun?.engine || "文本引擎"}`
      : "本次重跑不重新选题"
  });
  const script = want("script")
    ? await callStage("script", slots.script.content, `日期：${date}\n时段：${period}\n篇幅原则：${lengthPrinciple}。先让结构、呼吸、身体扫描、意象旅程和结尾自然完成；不得填充空话，也不得省略必要段落。\n已自动选择且查重通过的选题：\n${topic}\n\n请完成可直接配音的催眠冥想文稿。开场保持自然完整句，之后逐渐放慢；中午结尾必须完整唤醒，晚上结尾不得唤醒。`)
    : String(reuse?.script || "");
  if (!want("script")) {
    if (!script) throw new Error("上次的原稿记录为空，无法在复用原稿的前提下重跑");
    progress({ step: "script", status: "done", progress: 36, message: "复用上次原稿" });
  }
  await onPartial?.({ topic, script, engineRuns: runs });
  const optimizerRuntime = slots.ttsOptimizer
    ? `${slots.ttsOptimizer.content}\n\n# 本地应用输出约定\n本地应用已经负责 MiniMax JSON 请求、voice_setting、audio_setting、curl 与文件保存。当前步骤只负责改写 text 字段。最终只输出加工后的 TTS 纯文本，不输出标题、解释、参数、JSON、curl、代码围栏或预计时长。自然语气与语义留白优先，按内容自然结束。确保所有 <#x#> 标记合法且不连续。禁止输出 (inhale)、(exhale)、(breath)、(sighs)、(humming) 等英文括号动作标签；统一改成“轻轻吸气”“缓缓呼气”“自然换气”等听众应该直接听见的中文提示。禁止用“呼——吸——”等机械拟声。输出前再次扫描并清除所有此类内容。${durationPlan ? `本次为 ${durationPlan.minutes} 分钟校准版，最终 TTS 纯文本的中文字也必须保持在 ${durationPlan.minChars}–${durationPlan.maxChars} 字；只优化停顿和必要的中文呼吸提示，禁止扩写内容。` : ""}`
    : null;
  const pacingMode = slots.ttsOptimizer?.name === "minimax-meditation-tts-extreme-immersion" ? "extreme" : "natural";
  let optimized = want("tts")
    ? sanitizeTtsText(slots.ttsOptimizer
      ? await callStage("tts", optimizerRuntime, `请把下面文稿优化成可直接放入 MiniMax T2A text 字段的最终纯文本，保留内容含义，加入必要的停顿、中文呼吸提示和自然语气：\n\n${script}`)
      : script)
    : sanitizeTtsText(String(reuse?.optimized || ""));
  if (!want("tts") && !optimized) throw new Error("上次的配音文本记录为空，无法在复用配音文本的前提下重跑");
  if (want("tts") && slots.ttsOptimizer && durationPlan) {
    const optimizedChars = countHanCharacters(optimized);
    if (optimizedChars < durationPlan.minChars || optimizedChars > durationPlan.maxChars) {
      progress({
        step: "tts",
        status: "running",
        progress: 43,
        message: "检测到配音优化改变了目标篇幅，正在按实听标尺重新收紧",
        detail: `当前 ${optimizedChars} 字 · 目标 ${durationPlan.minChars}–${durationPlan.maxChars} 字`
      });
      // 收紧是**优化**，不是必需 —— 上一版已经是可用的配音文本，只是篇幅偏了。
      // 收紧调用失败（超时、限流、接口抖动）时保留上一版继续跑，
      // 而不是把整条流程连同已经生成的选题和原稿一起丢掉。
      // （2026-07-25 实测：收紧调用 180s 超时，导致整轮失败，
      //   而当时手上那版 1014 字的文本其实完全能用。）
      try {
        optimized = sanitizeTtsText(await callStage(
          "tts",
          optimizerRuntime,
          `上一版配音文本有 ${optimizedChars} 个中文字，超出 ${durationPlan.minutes} 分钟版的 ${durationPlan.minChars}–${durationPlan.maxChars} 字范围。请以原稿为准，只插入合法停顿并做最少量呼吸提示，禁止扩写、重复或增加新画面。最终中文字必须落在目标范围，只输出 TTS 纯文本：\n\n${script}`
        ));
      } catch (error) {
        progress({
          step: "tts",
          status: "running",
          progress: 45,
          message: `收紧篇幅失败，沿用上一版配音文本：${error.message}`,
          detail: `保留 ${optimizedChars} 字 · 成品时长会比 ${durationPlan.minutes} 分钟目标略长`
        });
      }
    }
    const finalChars = countHanCharacters(optimized);
    // 篇幅偏差只是时长不精确，不是不能用。硬性拦截会让整轮白跑，
    // 而人声、混音、视频这些下游步骤对篇幅并不敏感 —— 记一条警告继续走。
    if (finalChars < durationPlan.minChars || finalChars > durationPlan.maxChars) {
      const drift = Math.round(finalChars / 48.7);
      progress({
        step: "tts",
        status: "running",
        progress: 46,
        message: `配音文本 ${finalChars} 字，未落在 ${durationPlan.minutes} 分钟档的 ${durationPlan.minChars}–${durationPlan.maxChars} 字区间`,
        detail: `按字数推算成品约 ${drift} 分钟，仍继续生成`
      });
    }
  }
  let pacing = analyzeTtsPacing(optimized);
  if (want("tts") && slots.ttsOptimizer && ttsPacingNeedsRetry(pacing, pacingMode)) {
    const lowerBound = pacingMode === "extreme" ? 15 : 7;
    progress({
      step: "tts",
      status: "running",
      progress: 43,
      message: pacing.pauseSecondsPer100Chars < lowerBound ? "检测到留白不足，正在重新调整配音节奏" : "检测到停顿过密，正在重新调整配音节奏",
      detail: `每百字明确停顿 ${pacing.pauseSecondsPer100Chars} 秒`
    });
    const retryGuide = pacingMode === "extreme"
      ? "按极限滞后原则重做：每个内部中文标点后放置一个停顿；句内意群 1.5–2.5 秒，完整句 3.5–5.0 秒，卸防句 5.0–7.0 秒，呼吸和环境声接管 7.0–10.0 秒。最终一句末尾不要放标记。不要漏标，也不要连续放两个标记。"
      : "按自然节奏重做：800 字以上夜间稿的明确停顿总量控制在 0.07–0.11 秒/字。停顿落在完整意群、呼吸、身体部位转换、画面转换和入睡深化处，不要用单词式碎句或无意义停顿凑数。";
    optimized = sanitizeTtsText(await callStage(
      "tts",
      optimizerRuntime,
      `上一版节奏质检未通过：正文约 ${pacing.spokenChars} 字，明确停顿共 ${pacing.pauseSeconds} 秒，每百字 ${pacing.pauseSecondsPer100Chars} 秒。${retryGuide}按内容自然结束。只输出最终 TTS 纯文本：\n\n${script}`
    ));
    pacing = analyzeTtsPacing(optimized);
  }
  const hardLower = pacingMode === "extreme" ? 10 : 5.5;
  const hardUpper = pacingMode === "extreme" ? 100 : 16;
  // 复用上次配音文本时不再做这道质检：那份文本上次已经过闸，用户这次是**刻意**
  // 保留它去重跑下游（比如只换 BGM、只重跑画面）。在这里拦下来等于让人无路可走。
  if (want("tts") && pacing.spokenChars >= 800 && (pacing.pauseSecondsPer100Chars < hardLower || pacing.pauseSecondsPer100Chars > hardUpper)) {
    throw new Error(`配音文本自然节奏质检未通过（每百字明确停顿 ${pacing.pauseSecondsPer100Chars} 秒），已停止语音合成以避免再次生成赶读音频`);
  }
  if (!want("tts")) progress({ step: "tts", status: "done", progress: 48, message: "复用上次配音文本" });
  else if (!slots.ttsOptimizer) progress({ step: "tts", status: "done", progress: 48, message: "未绑定配音优化 Skill，已直接使用原稿" });
  const copywriterRuntime = slots.copywriter
    ? `${slots.copywriter.content}\n\n# 本地应用输出约定\n当前结果将由程序直接读取并写入发布清单。严格输出一个合法 JSON 对象，不要输出解释、Markdown、代码围栏或 JSON 之外的文字。若输入信息不足，仍应根据现有文稿生成，并把不确定项写入 qa.warnings。`
    : null;
  await onPartial?.({ topic, script, optimized, pacing, engineRuns: runs });
  const runCopy = want("copy") && slots.copywriter && !input.skipPublishingCopy;
  const publishingContext2 = runCopy ? await publishingContext(config) : "";
  const copy = runCopy
    ? stripDurationFromCopy(parseCopyPackage(await callStage("copy", copywriterRuntime, `日期：${date}\n选题：${topic}\n最终配音文本：${optimized}\n\n${publishingContext2}\n\n请生成平台原生标题、正文、标签和单变量迭代方案。严格遵守各平台字段限制。禁止在任何标题、正文或标签中出现时长（如「7分钟」「约10分钟」）——此刻成品时长尚未确定。`)))
    : (want("copy") ? null : (reuse?.copy ?? null));
  if (!runCopy) progress({
    step: "copy",
    status: "done",
    progress: 58,
    message: !want("copy")
      ? "复用上次发布文案"
      : (input.skipPublishingCopy ? "本次按要求跳过平台发布文案" : "未绑定发布文案 Skill，已跳过")
  });
  return {
    topic,
    script,
    optimized,
    pacing,
    copy,
    engineRuns: runs,
    warnings: [
      ...(!slots.ttsOptimizer ? ["未绑定 MiniMax 优化 Skill，本次直接使用写作稿配音。"] : []),
      ...(!slots.copywriter ? ["未绑定平台文案 Skill，本次不生成平台文案。"] : []),
      ...(input.skipPublishingCopy ? ["本次按要求只生成冥想文稿与音频，未生成平台发布文案。"] : [])
    ]
  };
}

export async function runAudioOnly(config, input, workspaceRoot, { onProgress } = {}) {
  const progress = (event) => onProgress?.(event);
  const jobId = `${input.date}-${Date.now()}`;
  const runDir = path.resolve(workspaceRoot, config.app.runRoot, jobId);
  progress({ step: "prepare", status: "running", progress: 1, message: "正在扫描历史选题库并排除重复" });
  const [topicHistory] = await Promise.all([
    loadTopicHistory(config, workspaceRoot),
    mkdir(runDir, { recursive: true })
  ]);
  progress({ step: "prepare", status: "done", progress: 3, message: "历史选题检查完成", detail: `已载入 ${topicHistory.length} 个历史题目` });

  const text = await runTextWorkflow(config, { ...input, skipPublishingCopy: true }, { onProgress, topicHistory });
  const selectedTopic = extractTopicRecord(text.topic);
  const base = safeName(input.outputName || selectedTopic?.title || input.date);
  const outputDir = path.resolve(workspaceRoot, config.app.outputRoot, input.date, base);
  const audioDir = path.join(outputDir, "音频");
  const textDir = path.join(outputDir, "文本");
  const manifestDir = path.join(outputDir, "清单");
  await Promise.all([
    mkdir(audioDir, { recursive: true }),
    mkdir(manifestDir, { recursive: true })
  ]);
  await Promise.all([
    writeJson(path.join(runDir, "text.json"), text),
    writeTextPackage(text, textDir, { runId: jobId, title: base }),
    recordTopic(config, workspaceRoot, text.topic, { source: path.join(textDir, "01-选题结果.txt") })
  ]);

  const { speech, voicePath, savedVoicePath } = await obtainVoice(config, text.optimized, runDir, audioDir, {
    progress,
    startProgress: 59,
    doneProgress: 76
  });

  progress({ step: "audio", status: "running", progress: 77, message: "正在选择背景音乐并混合人声" });
  const bgmPath = await selectDatedAsset(config.media.bgmRoot, input.date, [".mp3", ".wav", ".flac", ".m4a"], { strategy: "random" });
  const outputAudio = path.join(audioDir, `${base}.mp3`);
  const media = await renderAudio(config, {
    voicePath,
    bgmPath,
    outputAudio,
    onProgress: (ratio) => progress({
      step: "audio",
      status: ratio >= 1 ? "done" : "running",
      progress: Math.round(77 + ratio * 21),
      message: ratio >= 1 ? "冥想音频已经混合完成" : `正在混合音频 · ${Math.round(ratio * 100)}%`
    })
  });
  progress({ step: "files", status: "running", progress: 99, message: "正在整理文稿与音频" });
  const manifest = {
    jobId,
    title: selectedTopic?.title || base,
    date: input.date,
    status: "audio-ready",
    mode: "text-and-audio-only",
    textEngine: {
      mode: config.textEngine.mode,
      model: text.engineRuns?.[0]?.model || config.textProvider.model
    },
    text,
    speech: speech.info,
    assets: { voicePath: savedVoicePath, bgmPath },
    media,
    bgmGainDb: config.media.bgmGainDb,
    createdAt: new Date().toISOString()
  };
  await writeJson(path.join(manifestDir, `${base}.audio.json`), manifest);
  progress({ step: "files", status: "done", progress: 100, message: "文稿和音频已经整理完成", detail: outputDir });
  return manifest;
}

// ── 重跑时「复用上一次产物」的四个读盘函数 ────────────────────────────────
//
// 它们的返回形状必须和对应的生成函数一致（obtainVoice / renderAudio /
// renderVideo / generateCovers），因为下游的 manifest 和界面都按同一个形状读。
// 缺文件时统一抛错而不是静默返回空 —— 让「视频里没有音频」这类错误在这里
// 就炸掉，而不是等成品出来才发现。

async function reuseVoice(config, runDir, audioDir) {
  const voicePath = path.join(runDir, `voice.${config.minimax.format}`);
  const savedVoicePath = path.join(audioDir, `AI原始人声.${config.minimax.format}`);
  await access(voicePath).catch(() => {
    throw new Error(`找不到上次的 AI 人声（${voicePath}），这一档重跑需要它，请改从「生成 AI 人声」重跑`);
  });
  return { speech: null, voicePath, savedVoicePath };
}

async function reuseAudio(config, outputAudio, priorManifest) {
  await access(outputAudio).catch(() => {
    throw new Error(`找不到上次的合成音频（${outputAudio}），请改从「混合冥想音频」重跑`);
  });
  const ffprobe = resolveMediaBinary(config.media.ffprobePath, "ffprobe");
  const [totalDuration, info] = await Promise.all([probeDuration(ffprobe, outputAudio), stat(outputAudio)]);
  return {
    // voiceDuration 读不出来（成品里人声和 BGM 已经混在一起了），从上次清单带过来
    voiceDuration: priorManifest?.media?.voiceDuration,
    totalDuration,
    outputAudio,
    outputAudioSize: info.size,
    reused: true
  };
}

async function reuseVideo(config, outputVideo, priorManifest) {
  await access(outputVideo).catch(() => {
    throw new Error(`找不到上次的成品视频（${outputVideo}），请改从「生成并导出视频」重跑`);
  });
  const info = await stat(outputVideo);
  return {
    outputVideo,
    outputVideoSize: info.size,
    videoProfile: resolveVideoProfile(config.media),
    // visualMode / visualTimeline 描述的是这个 mp4 是**怎么合成的**。文件没变，
    // 这两项就还成立，必须从上次清单里带过来 —— 写死成 "reused" 等于把一条
    // 真实记录抹成占位符。
    visualMode: priorManifest?.media?.visualMode || "reused",
    visualTimeline: priorManifest?.media?.visualTimeline || null,
    reused: true
  };
}

/**
 * 沿用上次 Agnes 生成的画面素材（动态封面 + 纯净循环）。
 *
 * 这是重跑功能里最省时间的一环：Agnes 一轮 20–40 分钟，而「换首 BGM 重新混音」
 * 或「换个人声」只是让成品时长变了，画面素材本身完全可以直接拿来重新导出。
 * 素材是 Agnes 服务 output 目录下的 mp4，不随 run 目录清理，所以通常都还在；
 * 万一被清掉了就明确报错，让用户改从「生成并导出视频」重跑。
 */
async function reuseVisuals(priorManifest, progress) {
  const assets = priorManifest?.assets || {};
  const paths = [assets.introVideoPath, assets.loopVideoPath, assets.videoPath].filter(Boolean);
  if (!paths.length) throw new Error("上次清单里没有画面素材记录，请改从「生成并导出视频」重跑");
  for (const file of paths) {
    await access(file).catch(() => {
      throw new Error(`上次的画面素材已不存在（${file}），请改从「生成并导出视频」重跑`);
    });
  }
  progress?.({
    step: "video",
    status: "running",
    progress: 82,
    message: "复用上次 Agnes 画面，只重新导出视频",
    detail: "跳过 20–40 分钟的画面生成"
  });
  return {
    source: priorManifest?.media?.visualSource || "agnes",
    videoPath: assets.videoPath,
    introVideoPath: assets.introVideoPath,
    loopVideoPath: assets.loopVideoPath,
    agnes: priorManifest?.media?.agnes || null,
    warning: null
  };
}

/**
 * 把封面复制进成品目录，文件名带上标题。
 *
 * 非致命：封面只有 B 站要，复制失败不该把整条流水线带走 —— 那两张原图还在
 * bilibili 目录里，人工也能取。失败就返回空数组，清单里如实记成没归档。
 */
async function archiveCovers(coverResult, coverDir, base) {
  // generateCovers 和 reuseCovers 返回的字段都叫 path（不是 filePath）。
  // 之前这里按 filePath 过滤，结果永远是空数组 —— 归档整段静默空转，
  // 一张也没存，而且不报错。两个名字都认一下，免得再被字段名咬一次。
  const files = (coverResult?.covers || [])
    .map((item) => ({ name: item?.name || "", source: item?.path || item?.filePath || "" }))
    .filter((item) => item.source);
  if (!files.length) return [];
  try {
    await mkdir(coverDir, { recursive: true });
    const saved = [];
    for (const item of files) {
      const target = path.join(coverDir, `${base}-${path.basename(item.source)}`);
      await copyFile(item.source, target);
      saved.push({ name: item.name, path: target });
    }
    return saved;
  } catch (error) {
    console.warn(`[cover] 封面归档到成品目录失败，原图仍在 bilibili 文件夹：${error.message}`);
    return [];
  }
}

/** 封面存在固定目录（不按 run 分），所以「复用」就是确认那两张图还在。 */
async function reuseCovers() {
  const covers = [];
  for (const spec of COVER_SPECS) {
    const filePath = path.join(BILIBILI_DIR, `${spec.name}.png`);
    const info = await stat(filePath).catch(() => null);
    if (info) covers.push({ name: spec.name, path: filePath, size: spec.size, aspect: spec.aspect });
  }
  return covers.length ? { subtitle: "", covers, outputDir: BILIBILI_DIR, reused: true } : null;
}

/**
 * @param {object} [options.resumeText] - 已有的文本产物。传了就跳过文本阶段，
 *   直接从封面/人声往下跑（续跑用）。
 * @param {string} [options.resumeRunId] - 续跑时沿用原来的运行目录，
 *   这样人声等中间文件仍落在同一处。
 * @param {string} [options.rerunFrom] - 重跑某一步。取 RERUN_PLAN 的键，按那张表
 *   决定哪些阶段重做、哪些从上次的落盘产物复用。必须同时给 resumeRunId。
 *
 * 为什么重跑也走 runAll 而不另写函数：封面、Agnes、人声、混音、视频、整理、
 * 发布这一整条下游逻辑只应该有一份实现。真按每个重跑档各写一个函数，
 * 十个入口迟早各自漂移，最后没人说得清哪条路是对的。
 */
export async function runAll(config, input, workspaceRoot, { onProgress, resumeText, resumeRunId, rerunFrom, signal } = {}) {
  const progress = (event) => onProgress?.(event);
  // 取消检查点。放在每个耗时环节之前 —— 中途取消时最多再走一步就会停，
  // 而 ffmpeg 和 Agnes 轮询都拿到了同一个 signal，会被直接掐断。
  const ensureLive = () => { if (signal?.aborted) throw new CancelledError(); };
  const plan = rerunFrom ? RERUN_PLAN[rerunFrom] : null;
  if (rerunFrom && !plan) throw new Error(`未知的重跑起点：${rerunFrom}`);
  if (plan && !resumeRunId) throw new Error("重跑必须指定要复用的运行目录");
  /** 这一步这次要真跑，还是从上次产物里复用？ */
  const redo = (stage) => !plan || plan.media.includes(stage);
  const jobId = resumeRunId || `${input.date}-${Date.now()}`;
  const runDir = path.resolve(workspaceRoot, config.app.runRoot, jobId);
  // 把 runId 透给服务端：界面要按它去读 text.json 展示每一步的产物。
  progress({ step: "prepare", status: "running", progress: 1, message: "正在扫描历史选题库并排除重复", runId: jobId });
  const [topicHistory] = await Promise.all([
    loadTopicHistory(config, workspaceRoot),
    mkdir(runDir, { recursive: true })
  ]);
  progress({ step: "prepare", status: "done", progress: 3, message: "历史选题检查完成", detail: `已载入 ${topicHistory.length} 个历史题目` });

  // 分步落盘：每完成一个文本阶段就写一次 text.json。
  // 原来只在四步全跑完后写一次，中途失败（比如文本接口 401）前面的产出全丢，
  // 「继续」按钮也就无从续起。
  // resumeText：从已有文本续跑时传入，跳过整个文本阶段。
  // 刻意复用 runAll 而不是另写一个 resume 函数 —— 封面、Agnes、人声、混音、
  // 视频、整理、发布这一整条下游逻辑只应该有一份，否则迟早两边漂移。
  // 重跑时读上次的 text.json 当基线：plan.text 里列到的阶段重新调 Skill，
  // 其余原样复用。plan.text 为空（比如只重跑封面、只重跑视频）时连
  // runTextWorkflow 都不进，四步全部标成复用。
  const priorText = plan ? await readJson(path.join(runDir, "text.json"), null) : null;
  if (plan && !priorText) throw new Error("找不到上次的文本记录，无法重跑");
  const reuseWholeText = plan && !plan.text.length;
  const text = resumeText
    || (reuseWholeText ? priorText : await runTextWorkflow(config, input, {
      onProgress,
      topicHistory,
      stages: plan?.text || null,
      reuse: priorText,
      onPartial: (partial) => writeJson(path.join(runDir, "text.json"), partial).catch(() => {})
    }));
  if (reuseWholeText) {
    for (const [step, message] of [
      ["prepare", "复用上次的选题检查"], ["topic", "复用上次选题"], ["script", "复用上次原稿"],
      ["tts", "复用上次配音文本"], ["copy", "复用上次发布文案"]
    ]) progress({ step, status: "done", progress: 54, message });
  }
  if (resumeText) {
    for (const [step, message] of [
      ["prepare", "复用上次的选题检查"], ["topic", "复用上次选题"],
      ["script", "复用上次原稿"], ["tts", "复用上次配音文本"], ["copy", "复用上次发布文案"]
    ]) progress({ step, status: "done", progress: 54, message });
  }
  const selectedTopic = extractTopicRecord(text.topic);
  const base = safeName(input.outputName || selectedTopic?.title || input.date);
  const outputDir = path.resolve(workspaceRoot, config.app.outputRoot, input.date, base);
  const audioDir = path.join(outputDir, "音频");
  const videoDir = path.join(outputDir, "视频");
  const textDir = path.join(outputDir, "文本");
  const manifestDir = path.join(outputDir, "清单");
  await Promise.all([
    mkdir(audioDir, { recursive: true }),
    mkdir(videoDir, { recursive: true }),
    mkdir(manifestDir, { recursive: true })
  ]);
  // 选题只在**本次真的重新选了**的时候入库。复用旧选题时它早就在历史里，
  // 再记一遍会让同一个题目在禁用清单里出现多次，也会污染「已收录 N 个」。
  const shouldRecordTopic = !plan || plan.text.includes("topic");
  await Promise.all([
    writeJson(path.join(runDir, "text.json"), text),
    writeTextPackage(text, textDir, { runId: jobId, title: base }),
    shouldRecordTopic
      ? recordTopic(config, workspaceRoot, text.topic, { source: path.join(textDir, "01-选题结果.txt") })
      : Promise.resolve()
  ]);
  // 封面图生成。
  //
  // 刻意做成**非致命**：封面只有 B 站需要，而这一步跑在人声之前 ——
  // 让它把整条流程带走，等于为了一张图丢掉后面的人声、混音和视频。
  // 失败或超时就标记警告继续走，B 站那一条发布时会因为缺封面报错，
  // 但音频、视频和其余平台照常产出。
  //
  // 另外加了整体超时兜底：内部虽然每个请求都有 timeout
  // （prompt 60s + 两张图各 120s + 下载各 60s），但没有总闸，
  // 卡在这一步时用户只能干等。
  // ── 文本完成后，三条互不依赖的线同时起跑 ──────────────────────────
  //
  //   text ──┬─► Agnes 画面（最长，30–60 分钟）──┐
  //          ├─► AI 人声 ─► 混音 ───────────────┴─► 视频 ─► 整理 ─► 发布
  //          └─► 封面图（只有 B 站要，发布前收就行）
  //
  // Agnes 必须**第一个**起跑：它是关键路径上最长的一环，晚一分钟启动，
  // 整条流程就晚一分钟结束。原来的顺序是先 await 封面（最多 5 分钟）
  // 再启动 Agnes，等于把 Agnes 白白推迟 —— 注释还写着「与 Agnes 并行启动」，
  // 和实际 await 顺序自相矛盾。
  // 上次的清单：重跑时用来找回那些「这次不重做」的环节的元数据（BGM 路径、
  // MiniMax 合成信息等），它们不在文件名里，只存在清单里。
  const priorManifest = plan
    ? await readJson(path.join(manifestDir, `${base}.publish.json`), null)
    : null;

  const outputAudio = path.join(audioDir, `${base}.mp3`);
  const outputVideo = path.join(videoDir, `${base}.mp4`);

  // visuals（Agnes 出画面）和 video（ffmpeg 导出成品）分开判断：
  // 换 BGM / 换人声只需要重导视频，不需要让 Agnes 再跑 40 分钟。
  ensureLive();
  const agnesTask = redo("visuals")
    ? startAgnesVisualTask(config, text, selectedTopic?.title || base, progress, signal)
    : null;

  // 封面丢到后台跑，到组装清单前才收。它只在 B 站发布时才需要，
  // 不参与视频合成，没有任何理由挡在关键路径上。
  const coverTask = !redo("cover")
    ? reuseCovers().then((existing) => {
      progress({
        step: "cover",
        status: "done",
        progress: 58,
        message: existing ? "复用上次封面" : "上次的封面文件已不在，本次不重新生成",
        detail: existing ? existing.outputDir : "B 站发布需要封面，可单独重跑这一步"
      });
      return existing;
    })
    : input.skipCover
      ? Promise.resolve(null)
      : withTimeout(generateCovers(text, { onProgress: progress, config }), COVER_TIMEOUT_MS, "封面生成超时")
        .catch((error) => {
          // 在创建处就接住，避免变成 unhandled rejection
          progress({
            step: "cover",
            status: "done",
            progress: 58,
            message: `封面生成未完成，已跳过：${error.message}`,
            detail: "音频和视频会继续生成；B 站发布需要封面，请手动准备后再发"
          });
          return null;
        });
  if (redo("cover") && input.skipCover) {
    progress({ step: "cover", status: "done", progress: 58, message: "按设置跳过封面生成", detail: "B 站发布需要封面，请手动准备" });
  }

  ensureLive();
  const { speech, voicePath, savedVoicePath } = redo("voice")
    ? await obtainVoice(config, text.optimized, runDir, audioDir, {
      progress,
      startProgress: 59,
      doneProgress: 70
    })
    : await reuseVoice(config, runDir, audioDir);
  if (!redo("voice")) {
    progress({ step: "voice", status: "done", progress: 70, message: "复用上次 AI 人声", detail: savedVoicePath });
  }

  // BGM 每次混音都重新随机抽 —— 「换个背景音乐再听听」正是重跑混音的主要动机。
  // 不重做混音时沿用上次清单里记的那首，保证清单如实反映成品里到底是哪首。
  ensureLive();
  let bgmPath = priorManifest?.assets?.bgmPath || "";
  let audio;
  if (redo("audio")) {
    progress({ step: "audio", status: "running", progress: 71, message: "正在选择背景音乐并混合人声" });
    bgmPath = await selectDatedAsset(config.media.bgmRoot, input.date, [".mp3", ".wav", ".flac", ".m4a"], { strategy: "random" });
    audio = await renderAudio(config, {
      voicePath,
      bgmPath,
      outputAudio,
      signal,
      onProgress: (ratio) => progress({
        step: "audio",
        status: ratio >= 1 ? "done" : "running",
        progress: Math.round(71 + ratio * 11),
        message: ratio >= 1 ? "冥想音频已经混合完成" : `正在混合音频 · ${Math.round(ratio * 100)}%`
      })
    });
    progress({ step: "audio", status: "done", progress: 82, message: "冥想音频已经混合完成", detail: outputAudio });
  } else {
    audio = await reuseAudio(config, outputAudio, priorManifest);
    progress({ step: "audio", status: "done", progress: 82, message: "复用上次合成音频", detail: outputAudio });
  }

  // 画面素材：这次让 Agnes 重跑，还是沿用上次那两段？
  ensureLive();
  const visuals = redo("visuals")
    ? await resolveVisualAssets(config, input, agnesTask, progress)
    : await reuseVisuals(priorManifest, progress);

  ensureLive();
  let video;
  if (redo("video")) {
    video = await renderVideo(config, {
      audioPath: outputAudio,
      audioDuration: audio.totalDuration,
      videoPath: visuals.videoPath,
      introVideoPath: visuals.introVideoPath,
      loopVideoPath: visuals.loopVideoPath,
      endFadeSeconds: visuals.source === "agnes" ? agnesEndFadeSeconds(config) : 0,
      outputVideo,
      signal,
      onProgress: (ratio) => progress({
        step: "video",
        status: ratio >= 1 ? "done" : "running",
        progress: Math.round(83 + ratio * 15),
        message: ratio >= 1 ? "成品视频已经导出" : `正在压缩并导出视频 · ${Math.round(ratio * 100)}%`
      })
    });
    progress({ step: "video", status: "done", progress: 98, message: "成品视频已经导出", detail: `${video.videoProfile.width}×${video.videoProfile.height} · ${video.videoProfile.fps} 帧` });
  } else {
    video = await reuseVideo(config, outputVideo, priorManifest);
    progress({ step: "video", status: "done", progress: 98, message: "复用上次成品视频", detail: outputVideo });
  }

  const media = { ...audio, ...video, visualSource: visuals.source, agnes: visuals.agnes, warnings: visuals.warning ? [visuals.warning] : [] };
  progress({ step: "files", status: "running", progress: 99, message: "正在整理文本、音频、视频和发布清单" });
  // 后台跑的封面到这里才收 —— 视频渲染期间它多半早就好了
  const coverResult = await coverTask;
  // 封面另存一份进成品目录。
  //
  // 生成时它们落在固定的 ~/Desktop/bilibili/（B 站上传要去那儿取），文件名还写死成
  // 4比3.png / 16比9.png —— 意味着**下一次运行会原地覆盖**。隔一天回头看，成品目录里
  // 音频视频文案都在，唯独封面已经换成别人的了，对不上账。这里按 run 存一份，
  // 成品从此是自足的；bilibili 那两张照旧，不影响 B 站上传。
  const archivedCovers = await archiveCovers(coverResult, path.join(outputDir, "封面"), base);
  const manifest = {
    jobId,
    title: selectedTopic?.title || base,
    date: input.date,
    status: "ready-for-draft",
    skills: (await composeWorkflow(config, input.brief)).map((step) => step.skill),
    rerunFrom: rerunFrom || null,
    text,
    // 复用人声时没有本次的 MiniMax 合成信息，沿用上次清单里的，别写成 null
    // 把一条真实存在的记录抹掉。
    speech: speech?.info ?? priorManifest?.speech ?? null,
    cover: coverResult ? { ...coverResult, archived: archivedCovers } : null,
    assets: {
      voicePath: savedVoicePath,
      bgmPath,
      videoPath: visuals.videoPath,
      introVideoPath: visuals.introVideoPath,
      loopVideoPath: visuals.loopVideoPath,
      // 界面的产出列表要能直接打开它们，所以路径得进清单。
      // 之前只有音频和视频进来，封面和文案 txt 在盘上却在界面上看不见。
      copyTxtPath: path.join(textDir, "04-跨平台发布文案.txt"),
      copyJsonPath: path.join(textDir, "04-跨平台发布文案.json")
    },
    media,
    publishing: config.publishing,
    createdAt: new Date().toISOString()
  };
  await writeJson(path.join(manifestDir, `${base}.publish.json`), manifest);
  // 安全边界：工作流完成后只生成草稿交接清单，不自动调用任何正式发布服务。
  // 用户在弹窗核对媒体和七平台文案后，才可点击“存入草稿箱”。
  await writeJson(path.join(runDir, "draft-manifest.json"), manifest);
  progress({
    step: "publish",
    status: "done",
    progress: 100,
    message: "成品已就绪，等待确认存入草稿箱",
    detail: "没有正式发布任何内容；请在草稿弹窗中检查后手动开始"
  });
  progress({ step: "files", status: "done", progress: 100, message: "全部文件已整理完成", detail: outputDir });
  return manifest;
}

/**
 * 从媒体阶段续跑：复用已有的文本和人声，只重做混音 → 视频 → 整理 → 发布。
 *
 * 为什么值得单独存在：文本阶段重跑只花几毛钱，但**人声消耗 MiniMax 额度、
 * Agnes 生成画面动辄几十分钟**（历史上有一次跑了 60 分钟才超时）。
 * 媒体阶段失败时从头再来，等于把最贵的两步白扔一遍。
 *
 * 加了 onProgress：续跑同样要在界面看板上逐步点亮，否则用户面对的是十几分钟死寂。
 */
export async function resumeMedia(config, input, workspaceRoot, { onProgress, signal } = {}) {
  const progress = (event) => onProgress?.(event);
  const ensureLive = () => { if (signal?.aborted) throw new CancelledError(); };
  const jobId = String(input.jobId || "");
  if (!/^\d{4}-\d{2}-\d{2}-\d+$/.test(jobId)) throw new Error("续跑任务 ID 无效");
  const date = String(input.date || jobId.slice(0, 10));
  const runDir = path.resolve(workspaceRoot, config.app.runRoot, jobId);
  const base = safeName(input.outputName || date);
  const outputDir = path.resolve(workspaceRoot, config.app.outputRoot, date, base);
  const audioDir = path.join(outputDir, "音频");
  const videoDir = path.join(outputDir, "视频");
  const manifestDir = path.join(outputDir, "清单");
  await Promise.all([
    mkdir(audioDir, { recursive: true }),
    mkdir(videoDir, { recursive: true }),
    mkdir(manifestDir, { recursive: true })
  ]);
  const text = await readJson(path.join(runDir, "text.json"), null);
  if (!text) throw new Error("续跑任务缺少文本记录");
  const priorDraftManifest = await readJson(path.join(runDir, "draft-manifest.json"), null);
  const coverResult = priorDraftManifest?.cover || await withTimeout(
    generateCovers(text, { onProgress: progress, config }),
    COVER_TIMEOUT_MS,
    "补充封面生成超时"
  );

  // 前五步是复用的，直接在看板上标成已完成，让人一眼看出这次跳过了什么。
  for (const [step, message] of [
    ["prepare", "复用上次结果"], ["topic", "复用上次选题"], ["script", "复用上次原稿"],
    ["tts", "复用上次配音文本"], ["copy", "复用上次发布文案"], ["cover", "复用上次封面"],
    ["voice", "复用上次 AI 人声"]
  ]) progress({ step, status: "done", progress: 60, message });

  ensureLive();
  const agnesTask = startAgnesVisualTask(config, text, base, null, signal);
  const voicePath = path.join(runDir, `voice.${config.minimax.format}`);
  const bgmPath = await selectDatedAsset(config.media.bgmRoot, date, [".mp3", ".wav", ".flac", ".m4a"], { strategy: "random" });
  const outputAudio = path.join(audioDir, `${base}.mp3`);
  const outputVideo = path.join(videoDir, `${base}.mp4`);

  progress({ step: "audio", status: "running", progress: 70, message: "正在重新混合冥想音频" });
  const audio = await renderAudio(config, { voicePath, bgmPath, outputAudio, signal });
  progress({ step: "audio", status: "done", progress: 82, message: "冥想音频已经混合完成", detail: outputAudio });

  progress({ step: "video", status: "running", progress: 84, message: "正在通过 Agnes 生成画面并导出视频" });
  const visuals = await resolveVisualAssets(config, { ...input, date }, agnesTask, null);
  const video = await renderVideo(config, {
    audioPath: outputAudio,
    audioDuration: audio.totalDuration,
    videoPath: visuals.videoPath,
    introVideoPath: visuals.introVideoPath,
    loopVideoPath: visuals.loopVideoPath,
    endFadeSeconds: visuals.source === "agnes" ? agnesEndFadeSeconds(config) : 0,
    outputVideo
  });
  const media = { ...audio, ...video, visualSource: visuals.source, agnes: visuals.agnes, warnings: visuals.warning ? [visuals.warning] : [] };
  const manifest = {
    jobId,
    date,
    status: "ready-for-draft",
    resumed: true,
    text,
    cover: coverResult,
    assets: {
      voicePath,
      bgmPath,
      videoPath: visuals.videoPath,
      introVideoPath: visuals.introVideoPath,
      loopVideoPath: visuals.loopVideoPath
    },
    media,
    publishing: config.publishing,
    createdAt: new Date().toISOString()
  };
  progress({ step: "video", status: "done", progress: 98, message: "成品视频已经导出" });
  progress({ step: "files", status: "running", progress: 99, message: "正在整理文件与发布清单" });
  await writeJson(path.join(manifestDir, `${base}.publish.json`), manifest);
  await writeJson(path.join(runDir, "draft-manifest.json"), manifest);
  progress({
    step: "publish",
    status: "done",
    progress: 100,
    message: "成品已就绪，等待确认存入草稿箱",
    detail: "没有正式发布任何内容；请在草稿弹窗中检查后手动开始"
  });
  progress({ step: "files", status: "done", progress: 100, message: "全部文件已整理完成", detail: outputDir });
  return manifest;
}

export async function resumeAudio(config, input, workspaceRoot) {
  const jobId = String(input.jobId || "");
  if (!/^\d{4}-\d{2}-\d{2}-\d+$/.test(jobId)) throw new Error("续跑任务 ID 无效");
  const date = String(input.date || jobId.slice(0, 10));
  const runDir = path.resolve(workspaceRoot, config.app.runRoot, jobId);
  const base = safeName(input.outputName || `${date}-冥想混音`);
  const outputDir = path.resolve(workspaceRoot, config.app.outputRoot, date, base);
  const audioDir = path.join(outputDir, "音频");
  const manifestDir = path.join(outputDir, "清单");
  await Promise.all([mkdir(audioDir, { recursive: true }), mkdir(manifestDir, { recursive: true })]);
  const voicePath = path.join(runDir, `voice.${config.minimax.format}`);
  const bgmPath = await selectDatedAsset(config.media.bgmRoot, date, [".mp3", ".wav", ".flac", ".m4a"], { strategy: "random" });
  const outputAudio = path.join(audioDir, `${base}.mp3`);
  const media = await renderAudio(config, { voicePath, bgmPath, outputAudio });
  const result = {
    jobId,
    date,
    status: "audio-ready",
    resumed: true,
    assets: { voicePath, bgmPath },
    media,
    bgmGainDb: config.media.bgmGainDb,
    createdAt: new Date().toISOString()
  };
  await writeJson(path.join(manifestDir, `${base}.audio.json`), result);
  return result;
}
