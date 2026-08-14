import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deepMerge, readJson, writeJson } from "./src/json-store.mjs";
import { applyEnvOverrides, localOnlyPaths } from "./src/env-config.mjs";
import { compareInfo, readCompareBaseline, runCompareStep, saveCompareOutputs, testCompareProvider } from "./src/compare.mjs";
import { listMediaLibrary } from "./src/library.mjs";
import { deleteOutputRun, listOutputRuns } from "./src/output-store.mjs";
import { checkBinary, resolveMediaBinary } from "./src/media.mjs";
import { synthesizeMinimax } from "./src/providers.mjs";
import {
  deleteMinimaxKey,
  deleteTextProviderKey,
  minimaxKeyStatus,
  textProviderKeyStatus,
  writeMinimaxKey,
  writeTextProviderKey
} from "./src/secrets.mjs";
import { readSkillById, scanSkills } from "./src/skills.mjs";
import {
  composeWorkflow, resumeAudio, resumeMedia, runAll, runAudioOnly, runTextWorkflow,
  DEFAULT_DURATION_MINUTES, RERUN_PLAN
} from "./src/workflow.mjs";
import { callCodexCliText, inspectCodexCli } from "./src/codex-cli.mjs";
import { chooseMediaDirectory } from "./src/directory-picker.mjs";
import { extractTopicRecord, loadTopicHistory } from "./src/topic-history.mjs";
import { createAgnesBridgeJob, inspectAgnes } from "./src/agnes.mjs";
import {
  createDraftJob,
  getDraftJob,
  getLatestDraftJob,
  inspectDraftPublisher,
  loadDraftHandoff,
  loadLatestDraftHandoff,
  openDraftLogin,
  stopDraftService
} from "./src/draft-publisher.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const DEFAULT_CONFIG_FILE = path.join(ROOT, "data/default-config.json");
const CONFIG_FILE = process.env.SLEEPFLOW_CONFIG_FILE
  ? path.resolve(process.env.SLEEPFLOW_CONFIG_FILE)
  : path.join(ROOT, "data/config.json");
const defaults = JSON.parse(await readFile(DEFAULT_CONFIG_FILE, "utf8"));
const jobs = new Map();
let latestJobId = null;

const JOB_STEPS = [
  ["prepare", "检查历史选题", "扫描选题库并排除重复"],
  ["topic", "确定选题", "选择主题、时段与画面方向"],
  ["script", "创作原稿", "生成完整催眠冥想文稿"],
  ["tts", "优化配音文本", "整理停顿、语气与呼吸提示"],
  ["copy", "整理发布文案", "生成各平台标题、简介与标签"],
  ["cover", "生成封面图", "用 AI 生成 4:3 和 16:9 两张 bilibili 封面"],
  ["voice", "生成 AI 人声", "通过 MiniMax 合成助眠声音"],
  ["audio", "混合冥想音频", "加入背景音乐并完成音量处理"],
  ["video", "生成并导出视频", "Agnes 选景生成画面，动态封面后循环到音频结束"],
  ["files", "整理全部文件", "保存音频、视频、文本与清单"],
  ["publish", "准备平台草稿", "生成七平台交接清单，等待人工确认后存入草稿"]
];

const TERMINAL_JOB_STATUS = new Set(["completed", "failed", "cancelled"]);

function createJob(input) {
  const id = `job-${Date.now()}`;
  const now = new Date().toISOString();
  const job = {
    id,
    status: "queued",
    progress: 0,
    currentStep: "prepare",
    brief: String(input.brief || ""),
    outputName: String(input.outputName || ""),
    date: String(input.date || ""),
    // 留空按默认 10 分钟。前端也兜了一次，这里再兜一次，直调 API 时同样生效。
    durationMinutes: Number(input.durationMinutes) > 0
      ? Math.min(60, Math.max(3, Math.round(Number(input.durationMinutes))))
      : DEFAULT_DURATION_MINUTES,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    error: null,
    result: null,
    steps: JOB_STEPS.map(([stepId, label, description]) => ({ id: stepId, label, description, status: "idle", message: "等待开始", detail: "" })),
    events: [],
    _lastLoggedProgress: -10,
    _lastLoggedStep: null,
    _abort: new AbortController()
  };
  jobs.set(id, job);
  latestJobId = id;
  return job;
}

function updateJob(job, event) {
  const now = new Date().toISOString();
  const step = job.steps.find((item) => item.id === event.step);
  const previousStatus = step?.status;
  if (step) {
    step.status = event.status || step.status;
    step.message = event.message || step.message;
    step.detail = event.detail || step.detail;
    if (event.agnesJobId) step.agnesJobId = event.agnesJobId;
    // 发布步骤的逐平台结果，界面展开成表格用
    if (event.publish) step.publish = event.publish;
    step.updatedAt = now;
  }
  if (event.agnesJobId) job.agnesJobId = event.agnesJobId;
  if (event.publish) job.publish = event.publish;
  if (event.runId) job.runId = event.runId;
  // 终态不能被改回 running。Agnes 那条线是脱离 runAll 独立跑的，主流程
  // 早就失败/取消之后它还在回调 progress，以前这里无条件写 "running"，
  // 就把一个已经结束的任务复活成「卡在生成并导出」，界面上永远转圈。
  if (!TERMINAL_JOB_STATUS.has(job.status)) job.status = "running";
  job.currentStep = event.step || job.currentStep;
  job.progress = Math.max(job.progress, Math.min(100, Number(event.progress || 0)));
  const shouldLog = event.status === "done"
    || event.status === "error"
    || previousStatus !== event.status
    || job._lastLoggedStep !== event.step
    || job.progress - job._lastLoggedProgress >= 5;
  if (shouldLog) {
    job.events.push({
      time: now,
      step: event.step,
      status: event.status,
      progress: job.progress,
      message: event.message,
      detail: event.detail || "",
      agnesJobId: event.agnesJobId || job.agnesJobId || ""
    });
    job.events = job.events.slice(-120);
    job._lastLoggedProgress = job.progress;
    job._lastLoggedStep = event.step;
  }
}

function publicJob(job) {
  if (!job) return null;
  const { _lastLoggedProgress, _lastLoggedStep, _abort, ...safe } = job;
  return { ...safe, cancellable: !TERMINAL_JOB_STATUS.has(job.status) };
}

/**
 * 任务收尾。取消和失败都要 abort 那个 controller ——
 * Agnes 的轮询、ffmpeg 子进程都挂在它上面，不掐断就会变成后台孤儿：
 * 白烧 CPU，还会往用户已经放弃的成品目录里继续写文件。
 */
function finishJob(job, status, error = null) {
  job.status = status;
  job.completedAt = new Date().toISOString();
  if (error) job.error = error;
  job._abort?.abort();
  const current = job.steps.find((item) => item.id === job.currentStep);
  if (current && status !== "completed") {
    current.status = status === "cancelled" ? "cancelled" : "error";
    current.message = error || (status === "cancelled" ? "已取消" : current.message);
  }
  if (status === "cancelled") {
    for (const step of job.steps) {
      if (["running", "idle"].includes(step.status)) {
        step.status = "cancelled";
        if (step.status === "idle") step.message = "未开始，任务已取消";
      }
    }
  }
  job.events.push({
    time: job.completedAt,
    step: job.currentStep,
    status: status === "completed" ? "done" : status === "cancelled" ? "cancelled" : "error",
    progress: job.progress,
    message: error || (status === "cancelled" ? "任务已取消" : ""),
    detail: ""
  });
}

/**
 * 判断一个失败的任务能不能从媒体阶段续跑。
 *
 * 续跑的前提是文本和人声都已经落盘。挂在文本阶段（比如今天的 401）时
 * 这两样都没有，只能整体重跑 —— 与其让用户点了「继续」再看到一个
 * 语焉不详的报错，不如在按钮层面就说清楚。
 */
async function resumeReadiness(config, job) {
  if (!job.runId) {
    return { ok: false, reason: "这次任务还没跑到写盘就失败了，只能重新生成" };
  }
  return runReadiness(config, job.runId);
}

/**
 * 只看磁盘判断某次运行能不能续跑 —— 不依赖内存里的任务记录。
 *
 * 任务记录存在内存 Map 里，服务一重启就没了，但 work/runs 下的中间产物还在。
 * 之前的续跑只认内存任务，导致「重启后明明文件都在，却续不了」。
 */
async function runReadiness(config, runId) {
  const runDir = path.resolve(ROOT, config.app.runRoot, runId);
  const textFile = path.join(runDir, "text.json");
  const hasText = await access(textFile).then(() => true, () => false);
  if (!hasText) {
    return { ok: false, reason: "文本还没开始写盘就失败了，只能重新生成" };
  }
  // 文本是分步落盘的，可能只写了一半。四步齐了才算能续。
  const text = await readJson(textFile, null);
  const missing = ["topic", "script", "optimized"].filter((k) => !text?.[k]);
  if (missing.length) {
    return { ok: false, reason: `文本只完成了一部分（缺${missing.join("、")}），只能重新生成` };
  }

  const voiceFile = path.join(runDir, `voice.${config.minimax?.format || "mp3"}`);
  const hasVoice = await access(voiceFile).then(() => true, () => false);
  return hasVoice
    // 人声也在 → 只重做混音之后，最省
    ? { ok: true, runId, from: "audio", label: "文本和人声都还在，可以跳过前 7 步直接从混音继续" }
    // 只有文本 → 从封面和人声继续。省下的是文本阶段（四次模型调用）
    : { ok: true, runId, from: "voice", label: "文本还在，可以跳过前 5 步从封面和人声继续" };
}

/**
 * 扫描 work/runs，列出磁盘上所有还能续跑的运行。
 *
 * 这是「重启后仍能续跑」的关键：不看内存任务，只看文件。
 * 已经跑完的运行（成品目录里有 mp4）不列出来，免得旧运行越堆越多。
 */
/**
 * 「丢弃」用标记文件实现，不删数据。
 *
 * 一个未跑完的运行里有 text.json 和 voice.mp3（十几 MB，烧过 MiniMax 额度）。
 * 用户点「丢弃」想要的是**让它从列表里消失**，不见得是要销毁那份人声 ——
 * 后者不可逆，而且真想省磁盘可以单独清。所以这里只落一个标记：
 * 列表不再显示，文件原样留着，删掉标记文件就能恢复。
 */
function discardMarkerPath(config, runId) {
  return path.join(path.resolve(ROOT, config.app.runRoot), path.basename(runId), ".discarded");
}

async function isRunDiscarded(config, runId) {
  return access(discardMarkerPath(config, runId)).then(() => true).catch(() => false);
}

async function listResumableRuns(config) {
  const runRoot = path.resolve(ROOT, config.app.runRoot);
  let dirs = [];
  try {
    dirs = (await readdir(runRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, 20);
  } catch {
    return [];
  }

  const out = [];
  for (const runId of dirs) {
    // 用户主动丢弃过的就不再列出来。放弃的运行会一直堆在这个列表里，
    // 除了当噪音没有任何用处 —— 而且越堆越多会把真正想续的那条埋掉。
    if (await isRunDiscarded(config, runId)) continue;
    const check = await runReadiness(config, runId);
    if (!check.ok) continue;
    const text = await readJson(path.join(runRoot, runId, "text.json"), null);
    const title = extractTopicRecord(text?.topic)?.title || "";
    let updatedAt = null;
    try {
      updatedAt = (await stat(path.join(runRoot, runId, "text.json"))).mtime.toISOString();
    } catch { /* 时间读不到不影响续跑 */ }
    out.push({ ...check, title, updatedAt, date: runId.slice(0, 10) });
  }
  return out;
}

/**
 * 起一个续跑任务。和普通任务共用同一套 job 结构，界面无需特殊处理。
 *
 * 两档：
 *   from=audio → 人声已在，只重做混音之后（resumeMedia）
 *   from=voice → 只有文本，从封面和人声继续（runAll + resumeText）
 */
function startResumeJob(config, source, readiness) {
  const job = createJob({
    brief: source.brief,
    outputName: source.outputName,
    date: source.date,
    durationMinutes: source.durationMinutes
  });
  // createJob 内部已经 jobs.set + latestJobId，这里不用再登记一次
  job.runId = source.runId;
  job.resumedFrom = source.id;

  queueMicrotask(async () => {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    try {
      if (readiness.from === "voice") {
        // 只有文本：复用 runAll，跳过文本阶段，从封面 + 人声往下跑到发布
        const runDir = path.resolve(ROOT, config.app.runRoot, source.runId);
        const resumeText = await readJson(path.join(runDir, "text.json"), null);
        job.result = await runAll(
          config,
          {
            date: source.date,
            brief: source.brief,
            outputName: source.outputName,
            durationMinutes: source.durationMinutes,
            skipPublish: source.skipPublish
          },
          ROOT,
          {
            onProgress: (event) => updateJob(job, event),
            resumeText,
            resumeRunId: source.runId,
            signal: job._abort.signal
          }
        );
      } else {
        job.result = await resumeMedia(
          config,
          { jobId: source.runId, date: source.date, outputName: source.outputName },
          ROOT,
          { onProgress: (event) => updateJob(job, event), signal: job._abort.signal }
        );
      }
      job.progress = 100;
      finishJob(job, "completed");
    } catch (error) {
      if (error?.cancelled || job._abort.signal.aborted) finishJob(job, "cancelled", "任务已取消");
      else finishJob(job, "failed", error.message || "续跑失败");
    }
  });
  return job;
}

/**
 * 重跑某一步：复用上次运行目录里的产物，只重做 RERUN_PLAN 指定的那些环节。
 *
 * 和 startResumeJob 的区别：「继续」是失败后从中断处往下接，「重跑」是对**已经
 * 跑完**的某一步不满意，重做它和它下游真正受影响的部分。两者共用 job 结构和
 * runAll，界面无需特殊处理。
 */
async function startRerunJob(config, runId, from, { skipPublish } = {}) {
  const runDir = path.resolve(ROOT, config.app.runRoot, runId);
  const text = await readJson(path.join(runDir, "text.json"), null);
  if (!text) throw Object.assign(new Error("找不到这次运行的文本记录，无法重跑"), { statusCode: 409 });
  const plan = RERUN_PLAN[from];
  if (!plan) throw Object.assign(new Error(`不支持从「${from}」重跑`), { statusCode: 400 });
  // 复用选题时必须有选题记录，否则 runAll 里会以更晚、更难懂的方式失败
  if (!plan.text.includes("topic") && !extractTopicRecord(text.topic)) {
    throw Object.assign(new Error("这次运行的选题记录不完整，只能整体重新生成"), { statusCode: 409 });
  }

  // 「重新选题」这一档复用不了任何东西（RERUN_PLAN.topic 里四步文本和全部媒体
  // 都要重做），所以它就是一次全新生产，直接走 startJob。
  // 不能让它套用重跑那条路：那会沿用旧的 runId 和旧标题，结果是新的选题把上一篇
  // 的 text.json、人声，以及**上一篇成品目录里的音频视频**全部原地覆盖掉。
  if (from === "topic") {
    return startJob(config, {
      brief: "晚上",
      outputName: "",              // 留空，按新选出来的标题另建目录
      date: runId.slice(0, 10),
      durationMinutes: DEFAULT_DURATION_MINUTES,
      skipPublish: skipPublish === true
    });
  }

  const job = createJob({
    brief: "晚上",
    // 选题不变的档沿用同一个标题、同一个成品目录 —— 那是对同一篇的修订，就该覆盖。
    outputName: extractTopicRecord(text.topic)?.title || "",
    date: runId.slice(0, 10),
    durationMinutes: DEFAULT_DURATION_MINUTES
  });
  job.runId = runId;
  job.rerunFrom = from;

  queueMicrotask(async () => {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    try {
      job.result = await runAll(
        config,
        {
          date: job.date,
          brief: job.brief,
          outputName: job.outputName,
          durationMinutes: job.durationMinutes,
          // 正式发布已被移除；这个兼容字段只保留给旧运行记录读取，不触发外部提交。
          skipPublish: true
        },
        ROOT,
        {
          onProgress: (event) => updateJob(job, event),
          rerunFrom: from,
          resumeRunId: runId,
          signal: job._abort.signal
        }
      );
      job.progress = 100;
      finishJob(job, "completed");
    } catch (error) {
      if (error?.cancelled || job._abort.signal.aborted) finishJob(job, "cancelled", "任务已取消");
      else finishJob(job, "failed", error.message || "重跑失败");
    }
  });
  return job;
}

function startJob(config, input) {
  const job = createJob(input);
  queueMicrotask(async () => {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    try {
      // 用 job 上归一化后的时长，避免前端传来 "" / 0 / 超范围值直接落到工作流里
      job.result = await runAll(
        config,
        { ...input, durationMinutes: job.durationMinutes },
        ROOT,
        { onProgress: (event) => updateJob(job, event), signal: job._abort.signal }
      );
      job.progress = 100;
      finishJob(job, "completed");
    } catch (error) {
      if (error?.cancelled || job._abort.signal.aborted) finishJob(job, "cancelled", "任务已取消");
      else finishJob(job, "failed", error.message || "生成失败");
    }
  });
  return job;
}

async function openLocalOutput(config, target, reveal = false) {
  const outputRoot = path.resolve(ROOT, config.app.outputRoot);
  const resolved = path.resolve(String(target || ""));
  if (resolved !== outputRoot && !resolved.startsWith(`${outputRoot}${path.sep}`)) throw new Error("只能打开 output 文件夹中的结果");
  await access(resolved);
  const args = reveal ? ["-R", resolved] : [resolved];
  const child = spawn("/usr/bin/open", args, { detached: true, stdio: "ignore" });
  child.unref();
  return resolved;
}

async function getConfig() {
  const merged = deepMerge(defaults, await readJson(CONFIG_FILE, {}));
  // 环境变量在最后一层覆盖：本机不设就完全等价于以前的行为；
  // CI / 服务器上只靠环境变量就能跑，config.json 里可以不留任何绝对路径和密钥。
  return applyEnvOverrides(merged).config;
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new Error("请求内容过大");
  }
  return raw ? JSON.parse(raw) : {};
}

function staticFile(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const requested = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const file = path.resolve(PUBLIC, requested);
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: "禁止访问" });
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
  access(file).then(() => {
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    createReadStream(file).pipe(res);
  }).catch(() => json(res, 404, { error: "页面不存在" }));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/")) return staticFile(req, res);
    const config = await getConfig();

    if (req.method === "GET" && url.pathname === "/api/status") {
      const [ffmpeg, ffprobe, skills, codex, publisher, agnes] = await Promise.all([
        checkBinary(resolveMediaBinary(config.media.ffmpegPath, "ffmpeg")),
        checkBinary(resolveMediaBinary(config.media.ffprobePath, "ffprobe")),
        scanSkills(config.skillRoots),
        inspectCodexCli(config),
        inspectDraftPublisher(ROOT),
        inspectAgnes(config)
      ]);
      return json(res, 200, {
        ok: true,
        config,
        skills,
        runtime: { ffmpeg, ffprobe, node: process.version, codex, publisher, agnes },
        paths: {
          workspaceRoot: ROOT,
          outputRoot: path.resolve(ROOT, config.app.outputRoot),
          runRoot: path.resolve(ROOT, config.app.runRoot)
        }
      });
    }
    if (req.method === "GET" && url.pathname === "/api/integrations") {
      const agnes = await inspectAgnes(config);
      return json(res, 200, {
        name: "眠屿一体化工作台",
        schemaVersion: "1.0",
        services: {
          sleepflow: { connected: true, baseUrl: `http://127.0.0.1:${config.app.port}` },
          agnes
        },
        endpoints: {
          createWorkflow: "POST /api/workflow/jobs",
          latestWorkflow: "GET /api/workflow/jobs/latest",
          workflowStatus: "GET /api/workflow/jobs/:jobId",
          createAgnesVisual: "POST /api/agnes/jobs",
          agnesStatus: "GET /api/agnes/status",
          draftStatus: "GET /api/draft-publisher/status",
          draftPayload: "GET /api/draft-publisher/runs/:runId/payload",
          createDraftJob: "POST /api/draft-publisher/jobs",
          draftJobStatus: "GET /api/draft-publisher/jobs/:jobId"
        },
        browserEvents: [
          "sleepflow:workflow-updated",
          "sleepflow:workflow-completed",
          "agnes:ready",
          "agnes:progress",
          "agnes:completed",
          "agnes:failed"
        ]
      });
    }
    if (req.method === "GET" && url.pathname === "/api/agnes/status") {
      return json(res, 200, await inspectAgnes(config));
    }
    if (req.method === "POST" && url.pathname === "/api/agnes/jobs") {
      const input = await body(req);
      if (!String(input.article || "").trim()) return json(res, 400, { error: "article 不能为空" });
      const created = await createAgnesBridgeJob(config, {
        article: String(input.article),
        title: String(input.title || "")
      });
      return json(res, 202, {
        job: created.job,
        embeddedUrl: created.embeddedUrl
      });
    }
    if (req.method === "PUT" && url.pathname === "/api/config") {
      const patch = await body(req);
      const next = deepMerge(config, patch);
      await writeJson(CONFIG_FILE, next);
      return json(res, 200, { ok: true, config: next });
    }
    if (req.method === "GET" && url.pathname === "/api/skills") {
      return json(res, 200, { skills: await scanSkills(config.skillRoots) });
    }
    if (req.method === "GET" && url.pathname === "/api/library/media") {
      return json(res, 200, await listMediaLibrary(config, url.searchParams.get("type")));
    }
    // 成品的列举与删除。列举带体积，因为「该删哪个」靠的就是这个数。
    if (req.method === "GET" && url.pathname === "/api/output/runs") {
      const outputRoot = path.resolve(ROOT, config.app.outputRoot);
      const runs = await listOutputRuns(outputRoot);
      return json(res, 200, {
        outputRoot,
        totalBytes: runs.reduce((sum, r) => sum + r.bytes, 0),
        runs
      });
    }
    // 删除走 DELETE + 请求体里的 relPath，不走查询串：成品标题是中文、
    // 还可能带空格和标点，塞进 URL 里编码解码要出岔子的地方太多。
    if (req.method === "DELETE" && url.pathname === "/api/output/runs") {
      const input = await body(req);
      const outputRoot = path.resolve(ROOT, config.app.outputRoot);
      try {
        return json(res, 200, await deleteOutputRun(outputRoot, input.relPath));
      } catch (error) {
        // 校验没过是调用方的问题（400），不是服务器炸了（500）——
        // 分清楚，前端才好把原因原样显示给人看
        return json(res, 400, { error: error.message });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/topic-history") {
      const topics = await loadTopicHistory(config, ROOT);
      return json(res, 200, { count: topics.length, topics });
    }
    if (req.method === "POST" && url.pathname === "/api/dialog/select-directory") {
      const input = await body(req);
      return json(res, 200, await chooseMediaDirectory(input.type));
    }
    if (req.method === "GET" && url.pathname === "/api/skills/source") {
      return json(res, 200, await readSkillById(config.skillRoots, url.searchParams.get("id")));
    }
    if (req.method === "GET" && url.pathname === "/api/minimax/key-status") {
      const mode = url.searchParams.get("mode") === "api" ? "api" : "subscription";
      const keychain = await minimaxKeyStatus(mode);
      const environmentName = mode === "subscription"
        ? (config.minimax.subscriptionApiKeyEnv || "MINIMAX_SUBSCRIPTION_KEY")
        : config.minimax.apiKeyEnv;
      const environment = Boolean(process.env[environmentName]);
      return json(res, 200, {
        configured: environment || keychain.configured,
        mode,
        source: environment ? "environment" : (keychain.configured ? "keychain" : "none")
      });
    }
    if (req.method === "GET" && url.pathname === "/api/text/key-status") {
      const keychain = await textProviderKeyStatus();
      const environment = Boolean(process.env[config.textProvider.apiKeyEnv]);
      return json(res, 200, {
        configured: environment || keychain.configured,
        source: environment ? "environment" : (keychain.configured ? "keychain" : "none")
      });
    }
    if (req.method === "GET" && url.pathname === "/api/codex/status") {
      return json(res, 200, await inspectCodexCli(config));
    }
    if (req.method === "GET" && url.pathname === "/api/publisher/status") {
      return json(res, 200, await inspectDraftPublisher(ROOT));
    }
    // 兼容旧界面路径；现在只返回草稿服务和七平台登录状态。
    if (
      req.method === "GET"
      && ["/api/publishing/status", "/api/draft-publisher/status"].includes(url.pathname)
    ) {
      return json(res, 200, await inspectDraftPublisher(ROOT));
    }
    if (
      req.method === "GET"
      && /^\/api\/draft-publisher\/runs\/.+\/payload$/.test(url.pathname)
    ) {
      const runId = decodeURIComponent(
        url.pathname.slice(
          "/api/draft-publisher/runs/".length,
          -"/payload".length
        )
      );
      return json(res, 200, {
        handoff: await loadDraftHandoff(config, ROOT, runId)
      });
    }
    if (req.method === "GET" && url.pathname === "/api/draft-publisher/runs/latest") {
      return json(res, 200, { handoff: await loadLatestDraftHandoff(config, ROOT) });
    }
    if (
      req.method === "GET"
      && /^\/api\/draft-publisher\/runs\/.+\/assets\/(video|audio|cover4x3|cover16x9|copytxt)$/.test(url.pathname)
    ) {
      const match = url.pathname.match(
        /^\/api\/draft-publisher\/runs\/(.+)\/assets\/(video|audio|cover4x3|cover16x9|copytxt)$/
      );
      const runId = decodeURIComponent(match[1]);
      const kind = match[2];
      const handoff = await loadDraftHandoff(config, ROOT, runId);
      const file = {
        video: handoff.assets.videoPath,
        audio: handoff.assets.audioPath,
        cover4x3: handoff.assets.cover4x3Path,
        cover16x9: handoff.assets.cover16x9Path,
        copytxt: handoff.assets.copyTxtPath
      }[kind];
      if (!file) return json(res, 404, { error: "这次运行没有这个产物" });
      await access(file);
      const info = await stat(file);
      const contentType = {
        video: "video/mp4",
        audio: "audio/mpeg",
        cover4x3: file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
        cover16x9: file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
        copytxt: "text/plain; charset=utf-8"
      }[kind];
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": info.size,
        "Cache-Control": "no-store"
      });
      return createReadStream(file).pipe(res);
    }
    // 一键打包：音频、视频、两张封面、七平台文案 txt 压成一个 zip。
    //
    // 用系统的 zip 而不是在 Node 里实现：这些文件加起来上百 MB，纯 JS 压缩要
    // 先整个读进内存；zip 命令直接读盘写盘，内存占用是常数。
    // 先把文件复制进一个临时文件夹再压，这样解开后是一个带日期和标题的文件夹，
    // 而不是五个文件散落在下载目录里。
    if (req.method === "GET" && /^\/api\/draft-publisher\/runs\/.+\/bundle$/.test(url.pathname)) {
      const runId = decodeURIComponent(
        url.pathname.slice("/api/draft-publisher/runs/".length, -"/bundle".length)
      );
      const handoff = await loadDraftHandoff(config, ROOT, runId);
      const folder = `${runId.slice(0, 10)}-${handoff.title || runId}`.replace(/[/\\:]/g, "_");
      const workRoot = path.join(os.tmpdir(), `bundle-${Date.now()}`);
      const staging = path.join(workRoot, folder);
      await mkdir(staging, { recursive: true });
      const wanted = [
        [handoff.assets.videoPath, `${handoff.title}.mp4`],
        [handoff.assets.audioPath, `${handoff.title}.mp3`],
        [handoff.assets.cover4x3Path, "封面-4比3.png"],
        [handoff.assets.cover16x9Path, "封面-16比9.png"],
        [handoff.assets.copyTxtPath, "七平台发布文案.txt"]
      ];
      let packed = 0;
      for (const [source, name] of wanted) {
        if (!source || !await access(source).then(() => true).catch(() => false)) continue;
        await copyFile(source, path.join(staging, name));
        packed += 1;
      }
      if (!packed) {
        await rm(workRoot, { recursive: true, force: true }).catch(() => {});
        return json(res, 404, { error: "这次运行还没有可下载的产物" });
      }
      const zipPath = path.join(workRoot, `${folder}.zip`);
      await new Promise((resolve, reject) => {
        const child = spawn("zip", ["-r", "-q", `${folder}.zip`, folder], { cwd: workRoot });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`zip 退出码 ${code}`)));
      });
      const info = await stat(zipPath);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": info.size,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${folder}.zip`)}`,
        "Cache-Control": "no-store"
      });
      const stream = createReadStream(zipPath);
      // 传完就清临时目录，否则每点一次下载就在 /tmp 里留一份上百 MB
      stream.on("close", () => { rm(workRoot, { recursive: true, force: true }).catch(() => {}); });
      return stream.pipe(res);
    }
    if (req.method === "POST" && url.pathname === "/api/draft-publisher/jobs") {
      const input = await body(req);
      const job = await createDraftJob(config, ROOT, {
        runId: String(input.runId || ""),
        platforms: input.platforms
      });
      return json(res, 202, { job });
    }
    if (req.method === "GET" && url.pathname === "/api/draft-publisher/jobs/latest") {
      const job = await getLatestDraftJob(
        config,
        ROOT,
        String(url.searchParams.get("runId") || "")
      );
      return job
        ? json(res, 200, { job })
        : json(res, 404, { error: "还没有草稿任务记录" });
    }
    if (
      req.method === "GET"
      && /^\/api\/draft-publisher\/jobs\/.+/.test(url.pathname)
    ) {
      const jobId = decodeURIComponent(
        url.pathname.slice("/api/draft-publisher/jobs/".length)
      );
      const job = await getDraftJob(config, ROOT, jobId);
      return job
        ? json(res, 200, { job })
        : json(res, 404, { error: "找不到这个草稿任务" });
    }
    if (
      req.method === "POST"
      && /^\/api\/draft-publisher\/platforms\/.+\/open-login$/.test(url.pathname)
    ) {
      const platform = decodeURIComponent(
        url.pathname.slice(
          "/api/draft-publisher/platforms/".length,
          -"/open-login".length
        )
      );
      return json(res, 200, await openDraftLogin(ROOT, platform));
    }
    // 前端无法直接 fetch 9222（CORS），用后端代理检测 Chrome CDP 状态
    if (req.method === "GET" && url.pathname === "/api/draft-publisher/cdp-check") {
      try {
        const cdpResp = await fetch("http://127.0.0.1:9222/json/list", {
          signal: AbortSignal.timeout(3000)
        });
        const pages = await cdpResp.json();
        return json(res, 200, { connected: true, pages: Array.isArray(pages) ? pages.map((p) => ({ url: p.url, title: p.title })) : [] });
      } catch (error) {
        return json(res, 200, { connected: false, error: error.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/codex/test") {
      const input = await body(req);
      const testConfig = deepMerge(config, {
        textEngine: {
          mode: "codex-cli",
          codexCli: input.settings || {}
        }
      });
      const result = await callCodexCliText(
        testConfig,
        "这是眠屿工作台的 Codex CLI 连接测试。不要使用工具，不要解释。",
        "只回复四个字：连接成功",
        { timeoutMs: 180_000 }
      );
      return json(res, 200, {
        ok: true,
        reply: result.text,
        model: result.model,
        reasoningEffort: result.reasoningEffort,
        elapsedMs: result.elapsedMs,
        path: result.path,
        version: result.version
      });
    }
    if (req.method === "PUT" && url.pathname === "/api/minimax/key") {
      const input = await body(req);
      const mode = input.mode === "api" ? "api" : "subscription";
      await writeMinimaxKey(input.apiKey, mode);
      return json(res, 200, { ok: true, configured: true, mode });
    }
    if (req.method === "PUT" && url.pathname === "/api/text/key") {
      const input = await body(req);
      await writeTextProviderKey(input.apiKey);
      return json(res, 200, { ok: true, configured: true });
    }
    if (req.method === "DELETE" && url.pathname === "/api/text/key") {
      await deleteTextProviderKey();
      return json(res, 200, { ok: true, configured: false });
    }
    if (req.method === "DELETE" && url.pathname === "/api/minimax/key") {
      const input = await body(req);
      const mode = input.mode === "api" ? "api" : "subscription";
      await deleteMinimaxKey(mode);
      return json(res, 200, { ok: true, configured: false, mode });
    }
    if (req.method === "POST" && url.pathname === "/api/minimax/test") {
      const input = await body(req);
      const testConfig = deepMerge(config, { minimax: input.settings || {} });
      const testText = String(input.text || "晚上好。<#1.2#>这是一段 MiniMax 助眠声音测试。<#1.5#>愿此刻的你，慢慢放松下来。").slice(0, 500);
      try {
        const result = await synthesizeMinimax(testConfig, testText);
        return json(res, 200, {
          ok: true,
          audioBase64: result.buffer.toString("base64"),
          mimeType: `audio/${testConfig.minimax.format === "mp3" ? "mpeg" : testConfig.minimax.format}`,
          info: result.info,
          debug: result.debug
        });
      } catch (error) {
        return json(res, 400, {
          ok: false,
          error: error.message || "MiniMax 测试失败",
          debug: error.debug || null
        });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/compare/info") {
      return json(res, 200, await compareInfo(config));
    }
    if (req.method === "GET" && url.pathname === "/api/compare/baseline") {
      return json(res, 200, await readCompareBaseline(ROOT));
    }
    if (req.method === "POST" && url.pathname === "/api/compare/test") {
      const input = await body(req);
      try {
        return json(res, 200, await testCompareProvider(config, input.provider));
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message || "文本 API 测试失败" });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/compare/run-step") {
      return json(res, 200, await runCompareStep(config, await body(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/compare/save") {
      return json(res, 200, await saveCompareOutputs(ROOT, await body(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/workflow/compose") {
      const input = await body(req);
      return json(res, 200, { steps: await composeWorkflow(config, input.brief || "") });
    }
    if (req.method === "POST" && url.pathname === "/api/workflow/run-text") {
      return json(res, 200, { result: await runTextWorkflow(config, await body(req)) });
    }
    if (req.method === "POST" && url.pathname === "/api/workflow/run-all") {
      return json(res, 200, { result: await runAll(config, await body(req), ROOT) });
    }
    if (req.method === "POST" && url.pathname === "/api/workflow/run-audio-only") {
      return json(res, 200, { result: await runAudioOnly(config, await body(req), ROOT) });
    }
    if (req.method === "POST" && url.pathname === "/api/workflow/jobs") {
      const input = await body(req);
      const job = startJob(config, input);
      return json(res, 202, { job: publicJob(job) });
    }
    // 磁盘上还能续跑的运行。界面在没有活动任务时用它把中断的运行列出来 ——
    // 任务记录只在内存里，服务重启就没了，但 work/runs 下的产物还在。
    if (req.method === "GET" && url.pathname === "/api/workflow/resumable-runs") {
      return json(res, 200, { runs: await listResumableRuns(config) });
    }
    // 丢弃一条中断的运行：只落标记，不删文件（见 discardMarkerPath 的注释）。
    // DELETE 丢弃，PUT 撤销 —— 误点了得能拿回来。
    if (/^\/api\/workflow\/runs\/.+\/discard$/.test(url.pathname)
      && ["DELETE", "PUT"].includes(req.method)) {
      const runId = decodeURIComponent(
        url.pathname.slice("/api/workflow/runs/".length, -"/discard".length)
      );
      if (!/^\d{4}-\d{2}-\d{2}-\d+$/.test(runId)) return json(res, 400, { error: "运行编号不合法" });
      const marker = discardMarkerPath(config, runId);
      const runDir = path.dirname(marker);
      if (!await access(runDir).then(() => true).catch(() => false)) {
        return json(res, 404, { error: "找不到这次运行" });
      }
      if (req.method === "DELETE") {
        await writeFile(marker, `${new Date().toISOString()}\n`, "utf8");
        return json(res, 200, { ok: true, discarded: true, runId });
      }
      await unlink(marker).catch(() => {});
      return json(res, 200, { ok: true, discarded: false, runId });
    }
    // 按 runId 直接续跑（不需要内存里存在对应任务）
    if (req.method === "POST" && /^\/api\/workflow\/runs\/.+\/resume$/.test(url.pathname)) {
      const runId = decodeURIComponent(
        url.pathname.slice("/api/workflow/runs/".length, -"/resume".length)
      );
      const payload = await body(req).catch(() => ({}));
      const check = await runReadiness(config, runId);
      if (!check.ok) return json(res, 409, { error: check.reason });
      const text = await readJson(
        path.join(path.resolve(ROOT, config.app.runRoot, runId), "text.json"), null
      );
      const job = startResumeJob(config, {
        id: null,
        runId,
        date: runId.slice(0, 10),
        brief: "晚上",
        outputName: extractTopicRecord(text?.topic)?.title || "",
        durationMinutes: DEFAULT_DURATION_MINUTES,
        skipPublish: true
      }, check);
      return json(res, 202, { job: publicJob(job) });
    }
    // 重跑某一步。body: { from, skipPublish }
    // from 取 RERUN_PLAN 的键，后端按那张表决定重做哪些、复用哪些。
    if (req.method === "POST" && /^\/api\/workflow\/runs\/.+\/rerun$/.test(url.pathname)) {
      const runId = decodeURIComponent(
        url.pathname.slice("/api/workflow/runs/".length, -"/rerun".length)
      );
      const payload = await body(req).catch(() => ({}));
      try {
        const job = await startRerunJob(config, runId, String(payload?.from || ""), {
          skipPublish: payload?.skipPublish
        });
        return json(res, 202, { job: publicJob(job) });
      } catch (error) {
        return json(res, error.statusCode || 500, { error: error.message });
      }
    }
    // 每一步的重跑代价说明。界面用它渲染按钮和「会连带重做什么」的提示。
    if (req.method === "GET" && url.pathname === "/api/workflow/rerun-plan") {
      return json(res, 200, { plan: RERUN_PLAN });
    }
    // 从媒体阶段续跑一个失败的任务：复用已有文本和人声，只重做混音之后的部分。
    // 保护的是最贵的两步（MiniMax 人声额度、Agnes 几十分钟的画面生成）。
    if (req.method === "POST" && /^\/api\/workflow\/jobs\/.+\/resume$/.test(url.pathname)) {
      const jobId = decodeURIComponent(
        url.pathname.slice("/api/workflow/jobs/".length, -"/resume".length)
      );
      const source = jobs.get(jobId);
      if (!source) return json(res, 404, { error: "找不到这个生成任务" });
      const check = await resumeReadiness(config, source);
      if (!check.ok) return json(res, 409, { error: check.reason });
      const job = startResumeJob(config, source, check);
      return json(res, 202, { job: publicJob(job) });
    }
    // 续跑前置检查：界面用它决定「继续」按钮是给出来还是灰掉
    if (req.method === "GET" && /^\/api\/workflow\/jobs\/.+\/resumable$/.test(url.pathname)) {
      const jobId = decodeURIComponent(
        url.pathname.slice("/api/workflow/jobs/".length, -"/resumable".length)
      );
      const source = jobs.get(jobId);
      if (!source) return json(res, 404, { error: "找不到这个生成任务" });
      return json(res, 200, await resumeReadiness(config, source));
    }
    // 取消正在跑的任务。abort 之后 runAll 会在下一个检查点抛出，
    // ffmpeg 直接收 SIGTERM，Agnes 的轮询也会立刻退出。
    if (req.method === "POST" && /^\/api\/workflow\/jobs\/.+\/cancel$/.test(url.pathname)) {
      const jobId = decodeURIComponent(
        url.pathname.slice("/api/workflow/jobs/".length, -"/cancel".length)
      );
      const job = jobs.get(jobId);
      if (!job) return json(res, 404, { error: "找不到这个生成任务" });
      if (TERMINAL_JOB_STATUS.has(job.status)) {
        return json(res, 409, { error: `这个任务已经${job.status === "completed" ? "完成" : "结束"}了，不用取消` });
      }
      finishJob(job, "cancelled", "任务已取消");
      return json(res, 200, { job: publicJob(job) });
    }
    if (req.method === "GET" && url.pathname === "/api/workflow/jobs/latest") {
      return json(res, 200, { job: publicJob(jobs.get(latestJobId)) });
    }
    // 任务的文本产物（选题 / 原稿 / 配音文本 / 发布文案）。
    // 界面把每一步做成可展开卡片，展开时要能看到这一步到底产出了什么。
    if (req.method === "GET" && /^\/api\/workflow\/jobs\/.+\/text$/.test(url.pathname)) {
      const jobId = decodeURIComponent(
        url.pathname.slice("/api/workflow/jobs/".length, -"/text".length)
      );
      const job = jobs.get(jobId);
      if (!job) return json(res, 404, { error: "找不到这个生成任务" });
      const runDir = path.resolve(ROOT, config.app.runRoot, job.runId || jobId);
      const text = await readJson(path.join(runDir, "text.json"), null);
      return json(res, 200, { text });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/workflow/jobs/")) {
      const jobId = decodeURIComponent(url.pathname.slice("/api/workflow/jobs/".length));
      const job = jobs.get(jobId);
      if (!job) return json(res, 404, { error: "找不到这个生成任务" });
      return json(res, 200, { job: publicJob(job) });
    }
    if (req.method === "POST" && url.pathname === "/api/files/open") {
      const input = await body(req);
      return json(res, 200, { ok: true, path: await openLocalOutput(config, input.path, Boolean(input.reveal)) });
    }
    if (req.method === "POST" && url.pathname === "/api/workflow/resume-media") {
      return json(res, 200, { result: await resumeMedia(config, await body(req), ROOT) });
    }
    if (req.method === "POST" && url.pathname === "/api/workflow/resume-audio") {
      return json(res, 200, { result: await resumeAudio(config, await body(req), ROOT) });
    }
    return json(res, 404, { error: "接口不存在" });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error.message || "运行失败" });
  }
});

const config = await getConfig();
server.listen(config.app.port, "127.0.0.1", () => {
  console.log(`${config.app.name} 已启动：http://127.0.0.1:${config.app.port}`);
  // 搬到别的机器时，下面这几条就是会当场炸掉的地方。启动时先说，
  // 好过跑到一半才报一个「找不到素材目录」而看不出根因。
  const local = localOnlyPaths(config);
  if (local.length) {
    console.log(`  提示：还有 ${local.length} 处指向本机路径，换机器前用环境变量覆盖（见 .env.example）：`);
    for (const item of local) console.log(`    ${item.path} → ${item.env}`);
  }
  // 两个名字都认：SENSENOVA_API_KEYS 是多把轮转的写法，SENSENOVA_API_KEY 是单把的旧写法。
  // 只查单数会在明明配好了的情况下报「未配置」，比不提示更糟。
  const senseKeys = [process.env.SENSENOVA_API_KEYS, process.env.SENSENOVA_API_KEY]
    .filter(Boolean).join(",").split(/[,;\n]/).map((k) => k.trim()).filter(Boolean);
  // 2026-08-14 起环境变量不是唯一来源了：cover.mjs 拿不到环境变量时会回退到
  // agnesHeadless 里那批 SenseNova key（同一家、同一个端点）。所以这里也得一起看，
  // 否则明明能跑却在启动时吓唬人一句「封面生成会报错」—— 比不提示更糟。
  const ah = config.agnesHeadless || {};
  const configKeys = [...(ah.directorKeys || []), ...(ah.scorerKeys || []), ...(ah.motionKeys || [])]
    .map((k) => String(k || "").trim()).filter(Boolean);
  const total = new Set([...senseKeys, ...configKeys]).size;
  if (!total) {
    console.log("  提示：没有可用的 SenseNova key，封面这一步会失败"
      + "（设 SENSENOVA_API_KEYS 环境变量，或在 config.json 的 agnesHeadless 里填，两者任一即可）");
  } else {
    const 来源 = senseKeys.length ? (configKeys.length ? "环境变量＋配置" : "环境变量") : "配置文件";
    console.log(`  封面密钥：${total} 把可用（来自${来源}）`);
  }
  // 把文本模型和密钥来源打出来。
  //
  // 这三样是绑定的：baseUrl、model、密钥。换供应商要一起换，只改一样就会
  // 401（地址换了 key 没换）或 404（key 换了模型名没换），而报错本身看不出
  // 是配错了。启动时先摊开，配错一眼就能发现。
  // 密钥来源只有两处：环境变量，或钥匙串。两处都要真查 —— 只要有一处是
  // 「猜」的，一台什么都没配的机器就会打出一行看着像配好了的日志，
  // 直到跑到选题才 401。查不到就明说没配。
  textProviderKeyStatus().then(({ configured }) => {
    const source = process.env[config.textProvider.apiKeyEnv]
      ? `环境变量 ${config.textProvider.apiKeyEnv}`
      : (configured ? "macOS 钥匙串" : "");
    console.log(`  文本模型：${config.textProvider.model} @ ${new URL(config.textProvider.baseUrl).host}`
      + (source ? `（密钥来自${source}）` : ""));
    if (!source) {
      console.log(`  提示：未配置文本密钥（环境变量 ${config.textProvider.apiKeyEnv} 或 macOS 钥匙串），选题和文稿会报错`);
    }
  }).catch(() => {});
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopDraftService();
    server.close(() => process.exit(0));
  });
}
