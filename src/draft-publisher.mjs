import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DRAFT_SERVICE_PORT = Number(process.env.SLEEPFLOW_DRAFT_PORT || 5409);
export const DRAFT_SERVICE_URL = `http://127.0.0.1:${DRAFT_SERVICE_PORT}`;

export const DRAFT_PLATFORMS = [
  { name: "douyin", label: "抖音", type: 3, kind: "video", copyKey: "douyin", mode: "draft" },
  { name: "kuaishou", label: "快手", type: 4, kind: "video", copyKey: "kuaishou", mode: "draft" },
  { name: "xiaohongshu", label: "小红书", type: 1, kind: "video", copyKey: "xiaohongshu", mode: "draft" },
  { name: "shipinhao", label: "视频号", type: 2, kind: "video", copyKey: "wechat_channels", mode: "draft" },
  { name: "bilibili", label: "哔哩哔哩", type: 5, kind: "video", copyKey: "bilibili", mode: "draft_then_health" },
  // 音频两家直接发布，视频一律进草稿箱（用户 2026-07-26 的分工）。
  // 改成 "prepared" 就退回「填好表单停在人工确认前」的安全模式。
  { name: "ximalaya", label: "喜马拉雅", type: 6, kind: "audio", copyKey: "ximalaya", mode: "publish" },
  { name: "netease", label: "网易云播客", type: 7, kind: "audio", copyKey: "netease_cloud_podcast", mode: "publish" }
];

const PLATFORM_BY_NAME = new Map(DRAFT_PLATFORMS.map((item) => [item.name, item]));
const TITLE_LIMIT = {
  douyin: 30,
  kuaishou: 50,
  xiaohongshu: 20,
  shipinhao: 80,
  bilibili: 80,
  ximalaya: 40,
  netease: 16
};

let serviceProcess = null;
let serviceLog = [];
const draftJobs = new Map();

function stripDuration(value) {
  return String(value || "")
    .replace(/[（(]\s*(?:\d+|[一二三四五六七八九十]+)\s*分钟\s*[)）]/g, "")
    .replace(/(?:约\s*)?(?:\d+|[一二三四五六七八九十]+)\s*分钟/g, "")
    .trim();
}

function cleanTags(value, limit = 10) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").replace(/^#+/, "").trim())
    .filter(Boolean))].slice(0, limit);
}

function normalizedCopy(copy, fallback, platform) {
  const title = stripDuration(copy?.title || fallback?.title || "睡前冥想")
    .slice(0, TITLE_LIMIT[platform.name] || 80);
  const description = stripDuration(
    copy?.description || fallback?.description || ""
  );
  const tags = cleanTags(copy?.tags || copy?.hashtags || fallback?.tags || fallback?.hashtags);
  return {
    title,
    description,
    tags,
    shortTitle: stripDuration(copy?.short_title || "").slice(0, 16)
  };
}

async function exists(file) {
  return Boolean(file) && access(file).then(() => true, () => false);
}

async function findManifest(root, jobId) {
  const pending = [root];
  while (pending.length) {
    const current = pending.shift();
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      if (!entry.isFile() || !entry.name.endsWith(".publish.json")) continue;
      try {
        const manifest = JSON.parse(await readFile(target, "utf8"));
        if (String(manifest.jobId || "") === jobId) return manifest;
      } catch {}
    }
  }
  return null;
}

function resolveCovers(manifest) {
  const covers = Array.isArray(manifest?.cover?.covers) ? manifest.cover.covers : [];
  const fourByThree = covers.find((cover) =>
    cover.aspect === "4:3" || cover.name === "4比3"
  )?.path || "";
  const sixteenByNine = covers.find((cover) =>
    cover.aspect === "16:9" || cover.name === "16比9"
  )?.path || "";
  return { fourByThree, sixteenByNine };
}

export function buildDraftHandoff({ runId, manifest, text }) {
  const copyRoot = text?.copy?.platforms || text?.copy || {};
  const fallback = copyRoot.bilibili || copyRoot.douyin || text?.copy?.universal || {};
  const covers = resolveCovers(manifest);
  const assets = {
    videoPath: manifest?.media?.outputVideo || "",
    audioPath: manifest?.media?.outputAudio || "",
    cover4x3Path: covers.fourByThree,
    cover16x9Path: covers.sixteenByNine,
    // 七平台文案的可读版。旧清单没有这个字段（是后加的），所以可能为空 ——
    // 调用方要允许它不存在，不能假定一定有。
    copyTxtPath: manifest?.assets?.copyTxtPath || ""
  };
  const platforms = DRAFT_PLATFORMS.map((platform) => ({
    ...platform,
    selected: true,
    copy: normalizedCopy(copyRoot?.[platform.copyKey], fallback, platform),
    mediaPath: platform.kind === "audio" ? assets.audioPath : assets.videoPath
  }));
  return {
    schemaVersion: "1.0",
    runId,
    title: stripDuration(manifest?.title || fallback?.title || runId),
    createdAt: manifest?.createdAt || new Date().toISOString(),
    assets,
    platforms
  };
}

/**
 * 只根据文案 JSON 拼出七平台清单（不需要成品路径）。
 *
 * buildDraftHandoff 要等媒体产出、清单落盘之后才能调；而成品里的
 * 「04-跨平台发布文案.txt」应该在整理文本那一步就写好，不该依赖发布环节。
 * 所以把「文案怎么归一化、平台怎么排」这段单独抽出来给两边共用。
 */
export function buildPlatformCopyList(text) {
  const copyRoot = text?.copy?.platforms || text?.copy || {};
  const fallback = copyRoot.bilibili || copyRoot.douyin || text?.copy?.universal || {};
  return DRAFT_PLATFORMS.map((platform) => ({
    ...platform,
    copy: normalizedCopy(copyRoot?.[platform.copyKey], fallback, platform)
  }));
}

/**
 * 渲染成给人看的 txt。
 *
 * assets 可以为空 —— 在整理文本那一步媒体还没落盘，那时就不写「要上传的文件」那段。
 */
export function renderPlatformCopyTxt({ title, runId, createdAt, platforms, assets }) {
  return exportLines({ title, runId, createdAt, platforms, assets }).join("\n");
}

/**
 * 把七平台文案整理成一个 txt 文件，保存到 run 目录下。
 * 文件名：平台文案-{runId}.txt
 */
/** 真正拼行的地方。exportCopyToTxt 和 renderPlatformCopyTxt 共用这一份。 */
function exportLines({ title, runId, createdAt, platforms, assets }) {

  const lines = [];
  const total = platforms.length;
  lines.push(`${title} · ${total} 个平台的发布文案`);
  lines.push("");
  lines.push(`运行编号：${runId}`);
  lines.push(`生成时间：${createdAt}`);
  lines.push("");
  // 先给一张目录，粘贴时一眼看到自己在第几家、这家是发布还是存草稿
  lines.push("目录");
  platforms.forEach((platform, index) => {
    const action = platform.mode === "publish" ? "直接发布" : "存草稿";
    lines.push(`  ${index + 1}. ${platform.label}（${platform.kind === "audio" ? "音频" : "视频"} · ${action}）`);
  });
  lines.push("");
  lines.push("每个平台的标题和简介都不一样，是分别写的，不要互相套用。");
  lines.push("=".repeat(64));
  lines.push("");

  platforms.forEach((platform, index) => {
    const copy = platform.copy || {};
    const action = platform.mode === "publish" ? "直接发布（不可撤销）" : "存草稿";
    lines.push(`${"=".repeat(64)}`);
    lines.push(`${index + 1} / ${total}　平台：${platform.label}`);
    lines.push(`${"=".repeat(64)}`);
    lines.push(`类型：${platform.kind === "audio" ? "音频" : "视频"}　｜　发布动作：${action}`);
    lines.push("");
    lines.push(`── 标题 ──`);
    lines.push(copy.title || "（无）");
    if (copy.shortTitle) {
      lines.push("");
      lines.push(`── 短标题 ──`);
      lines.push(copy.shortTitle);
    }
    lines.push("");
    lines.push(`── ${platform.name === "xiaohongshu" ? "正文" : "简介"} ──`);
    lines.push(copy.description || "（无）");
    lines.push("");
    if (copy.tags?.length) {
      lines.push(`── 标签 ──`);
      lines.push(copy.tags.map((t) => `#${t}`).join("  "));
      lines.push("");
    }
    // 整理文本那一步媒体还没落盘，这时没有 mediaPath，就不写这一段 ——
    // 写一堆「未找到」比不写更让人以为出错了。
    if (platform.mediaPath) {
      lines.push(`── 要上传的文件 ──`);
      lines.push(`${platform.kind === "audio" ? "音频" : "视频"}：${platform.mediaPath}`);
      if (platform.kind === "video" && assets?.cover4x3Path) {
        lines.push(`封面 4:3：${assets.cover4x3Path}`);
        lines.push(`封面 16:9：${assets.cover16x9Path}`);
      }
      lines.push("");
    }
  });

  return lines;
}

/**
 * 把七平台文案整理成一个 txt 文件，保存到 run 目录下。
 * 文件名：平台文案-{runId}.txt
 */
export async function exportCopyToTxt(handoff, runDir) {
  const txtPath = path.join(runDir, `平台文案-${handoff.runId}.txt`);
  await writeFile(txtPath, exportLines(handoff).join("\n"), "utf8");
  return txtPath;
}

export async function loadDraftHandoff(config, workspaceRoot, runId) {
  const safeRunId = String(runId || "");
  if (!/^\d{4}-\d{2}-\d{2}-\d+$/.test(safeRunId)) {
    throw new Error("运行编号无效");
  }
  const runDir = path.resolve(workspaceRoot, config.app.runRoot, safeRunId);
  const text = JSON.parse(await readFile(path.join(runDir, "text.json"), "utf8"));
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(path.join(runDir, "draft-manifest.json"), "utf8"));
  } catch {
    manifest = await findManifest(path.resolve(workspaceRoot, config.app.outputRoot), safeRunId);
  }
  if (!manifest) throw new Error("没有找到这次工作流的成品清单");
  const handoff = buildDraftHandoff({ runId: safeRunId, manifest, text });

  // 导出七平台文案 txt
  try {
    const txtPath = await exportCopyToTxt(handoff, runDir);
    console.log(`[draft] 平台文案已导出：${txtPath}`);
  } catch (e) {
    console.warn(`[draft] 平台文案 txt 导出失败：${e.message}`);
  }

  const missing = [];
  for (const [label, file] of [
    ["最终视频", handoff.assets.videoPath],
    ["最终音频", handoff.assets.audioPath],
    ["4:3封面", handoff.assets.cover4x3Path],
    ["16:9封面", handoff.assets.cover16x9Path]
  ]) {
    if (!(await exists(file))) missing.push(label);
  }
  return { ...handoff, ready: missing.length === 0, missing };
}

export async function loadLatestDraftHandoff(config, workspaceRoot) {
  const root = path.resolve(workspaceRoot, config.app.runRoot);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
  for (const runId of candidates) {
    try {
      return await loadDraftHandoff(config, workspaceRoot, runId);
    } catch {}
  }
  throw new Error("还没有可用的草稿交接清单");
}

function bundledPython(workspaceRoot) {
  const candidates = [
    process.env.SLEEPFLOW_DRAFT_PYTHON,
    path.join(workspaceRoot, "extensions/draft-publisher/runtime/python/bin/python3.11"),
    path.join(workspaceRoot, "extensions/draft-publisher/runtime/python/bin/python3"),
    path.join(workspaceRoot, "extensions/draft-publisher/app/.venv/bin/python")
  ].filter(Boolean);
  return candidates;
}

async function resolvePython(workspaceRoot) {
  for (const candidate of bundledPython(workspaceRoot)) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error("找不到内嵌 Intel Python 运行环境");
}

async function serviceJson(endpoint, options = {}) {
  const response = await fetch(`${DRAFT_SERVICE_URL}${endpoint}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(8_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.msg || payload.error || `HTTP ${response.status}`);
  return payload;
}

export async function ensureDraftService(workspaceRoot) {
  try {
    const payload = await serviceJson("/draftRuntimeStatus");
    return { connected: true, spawned: false, ...payload.data };
  } catch {}

  if (serviceProcess && serviceProcess.exitCode == null) {
    throw new Error("草稿服务正在启动，请稍后再试");
  }
  const python = await resolvePython(workspaceRoot);
  const appRoot = path.join(workspaceRoot, "extensions/draft-publisher/app");
  serviceProcess = spawn(python, [path.join(appRoot, "sau_backend.py")], {
    cwd: appRoot,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      DRAFT_CDP_PORT: "9222"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const capture = (chunk) => {
    serviceLog.push(String(chunk).replace(/(token|cookie|api[_-]?key)[^\n]*/ig, "$1=<redacted>"));
    serviceLog = serviceLog.join("").split("\n").slice(-60);
  };
  serviceProcess.stdout.on("data", capture);
  serviceProcess.stderr.on("data", capture);
  serviceProcess.once("exit", () => { serviceProcess = null; });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const payload = await serviceJson("/draftRuntimeStatus");
      return { connected: true, spawned: true, ...payload.data };
    } catch {}
  }
  throw new Error(`草稿服务启动失败：${serviceLog.slice(-3).join(" ").slice(0, 500)}`);
}

export async function inspectDraftPublisher(workspaceRoot) {
  try {
    const status = await ensureDraftService(workspaceRoot);
    return {
      connected: true,
      serviceUrl: DRAFT_SERVICE_URL,
      cdp: Boolean(status.cdp),
      platforms: DRAFT_PLATFORMS.map((platform) => {
        const accounts = (status.accounts || []).filter((account) => account.type === platform.type);
        return {
          ...platform,
          login: accounts.some((account) => account.status === "ok") ? "ok" : "missing",
          accounts
        };
      })
    };
  } catch (error) {
    return {
      connected: false,
      serviceUrl: DRAFT_SERVICE_URL,
      cdp: false,
      error: error.message,
      platforms: DRAFT_PLATFORMS.map((platform) => ({ ...platform, login: "missing", accounts: [] }))
    };
  }
}

function jobsRoot(config, workspaceRoot) {
  return path.join(path.dirname(path.resolve(workspaceRoot, config.app.runRoot)), "draft-jobs");
}

// 落盘失败不能打断发布。work/draft-jobs 会被沙箱挡住（EPERM），
// 以前这里一抛异常就顺着 runDraftJob 的 catch 再抛一次，变成未捕获的
// rejection 把整个服务带走 —— 任务只是记录不上，浏览器那边其实已经在传了。
// 内存里的 draftJobs 才是运行时状态的真身，磁盘只是重启后的备份。
async function saveJob(config, workspaceRoot, job) {
  try {
    const dir = jobsRoot(config, workspaceRoot);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
    job.persistError = undefined;
  } catch (error) {
    job.persistError = `任务记录写不进磁盘（${error.code || error.message}），发布本身不受影响，但重启后这条记录会丢`;
    console.error(`[draft-publisher] ${job.id} 状态落盘失败：${error.message}`);
  }
}

function publicJob(job) {
  return JSON.parse(JSON.stringify(job));
}

async function runDraftJob(config, workspaceRoot, job, handoff) {
  job.state = "running";
  job.startedAt = new Date().toISOString();
  await saveJob(config, workspaceRoot, job);
  const service = await inspectDraftPublisher(workspaceRoot);

  for (const result of job.results) {
    const platform = PLATFORM_BY_NAME.get(result.platform);
    result.state = "processing";
    result.startedAt = new Date().toISOString();
    await saveJob(config, workspaceRoot, job);
    const source = handoff.platforms.find((item) => item.name === platform.name);
    const account = service.platforms.find((item) => item.name === platform.name)
      ?.accounts?.find((item) => item.status === "ok");
    if (platform.type <= 4 && !account) {
      result.state = "needs_login";
      result.message = "没有可用登录态，请先在登录状态中重新登录";
      result.completedAt = new Date().toISOString();
      await saveJob(config, workspaceRoot, job);
      continue;
    }
    try {
      const response = await serviceJson("/draftAbsolute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: platform.type,
          mediaPath: source.mediaPath,
          accountFile: account?.filePath || "",
          title: source.copy.title,
          description: source.copy.description,
          tags: source.copy.tags,
          shortTitle: source.copy.shortTitle,
          coverPath: handoff.assets.cover4x3Path,
          coverLandscapePath: handoff.assets.cover16x9Path,
          // 只有 mode 为 publish 的平台（音频两家）才真的对外发布。
          // 视频平台的 mode 是 draft / draft_then_health，这里恒为 false。
          publish: platform.mode === "publish"
        }),
        signal: AbortSignal.timeout(30 * 60 * 1000)
      });
      const returned = response.data?.state;
      result.state = ["published", "prepared_for_manual_review"].includes(returned)
        ? returned : "draft_saved";
      result.message = response.data?.message || response.msg || "草稿处理完成";
    } catch (error) {
      result.state = /登录|cookie/i.test(error.message) ? "needs_login" : "failed";
      result.message = String(error.message || "处理失败").slice(0, 500);
    }
    result.completedAt = new Date().toISOString();
    await saveJob(config, workspaceRoot, job);
  }
  const failures = job.results.filter((item) => ["failed", "needs_login"].includes(item.state));
  job.state = failures.length ? (failures.length === job.results.length ? "failed" : "partial") : "success";
  job.completedAt = new Date().toISOString();
  await saveJob(config, workspaceRoot, job);
}

export async function createDraftJob(config, workspaceRoot, { runId, platforms }) {
  const handoff = await loadDraftHandoff(config, workspaceRoot, runId);
  if (!handoff.ready) throw new Error(`成品不完整：缺少${handoff.missing.join("、")}`);
  const selected = [...new Set(Array.isArray(platforms) ? platforms : [])]
    .filter((name) => PLATFORM_BY_NAME.has(name));
  if (!selected.length) throw new Error("至少选择一个平台");
  const active = [...draftJobs.values()].find((item) =>
    item.runId === runId && ["queued", "running"].includes(item.state)
  );
  if (active) return publicJob(active);

  const job = {
    id: `draft-${Date.now()}`,
    runId,
    state: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    results: selected.map((name) => ({
      platform: name,
      label: PLATFORM_BY_NAME.get(name).label,
      mode: PLATFORM_BY_NAME.get(name).mode,
      state: "queued",
      message: ""
    }))
  };
  draftJobs.set(job.id, job);
  await saveJob(config, workspaceRoot, job);
  runDraftJob(config, workspaceRoot, job, handoff).catch(async (error) => {
    job.state = "failed";
    job.error = String(error.message || error);
    job.completedAt = new Date().toISOString();
    await saveJob(config, workspaceRoot, job);
  });
  return publicJob(job);
}

export async function getDraftJob(config, workspaceRoot, jobId) {
  if (draftJobs.has(jobId)) return publicJob(draftJobs.get(jobId));
  const file = path.join(jobsRoot(config, workspaceRoot), `${path.basename(jobId)}.json`);
  try {
    const job = JSON.parse(await readFile(file, "utf8"));
    if (["queued", "running"].includes(job.state)) {
      for (const result of job.results || []) {
        if (["queued", "processing"].includes(result.state)) {
          result.state = "failed";
          result.message = "主服务曾中断，本平台没有自动重试；请检查平台页面后手动重新创建任务";
          result.completedAt = new Date().toISOString();
        }
      }
      const completed = (job.results || []).some((item) =>
        ["draft_saved", "prepared_for_manual_review", "published"].includes(item.state)
      );
      job.state = completed ? "partial" : "failed";
      job.error = "任务因主服务中断而停止，已恢复记录但未自动重试";
      job.completedAt = new Date().toISOString();
      await saveJob(config, workspaceRoot, job);
    }
    return job;
  } catch {
    return null;
  }
}

export async function getLatestDraftJob(config, workspaceRoot, runId = "") {
  const root = jobsRoot(config, workspaceRoot);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((entry) => entry.isFile() && /^draft-\d+\.json$/.test(entry.name))
    .map((entry) => entry.name.slice(0, -5))
    .sort((a, b) => b.localeCompare(a));
  for (const jobId of names) {
    const job = await getDraftJob(config, workspaceRoot, jobId);
    if (job && (!runId || job.runId === runId)) return job;
  }
  return null;
}

export async function openDraftLogin(workspaceRoot, platformName) {
  const platform = PLATFORM_BY_NAME.get(platformName);
  if (!platform) throw new Error("未知平台");
  await ensureDraftService(workspaceRoot);
  if (platform.type <= 4) {
    const status = await serviceJson("/draftRuntimeStatus");
    const account = status.data?.accounts?.find((item) => item.type === platform.type);
    return {
      mode: "qr",
      eventSourceUrl: `${DRAFT_SERVICE_URL}/login?type=${platform.type}&id=${encodeURIComponent(account?.name || platform.label)}`
    };
  }

  const urls = {
    bilibili: "https://member.bilibili.com/platform/upload/video/frame",
    ximalaya: "https://studio.ximalaya.com/upload",
    netease: "https://music.163.com/st/ncreator/upload?userType=3"
  };

  // 先检查 9222 是否已经有 Chrome 在跑
  let cdpAlreadyRunning = false;
  try {
    const resp = await fetch("http://127.0.0.1:9222/json/list", { signal: AbortSignal.timeout(3000) });
    if (resp.ok) cdpAlreadyRunning = true;
  } catch {
    // 9222 没人用，需要启动 Chrome
  }

  if (!cdpAlreadyRunning) {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const profile = path.join(os.homedir(), "Library/Application Support/眠屿工作台/draft-browser-profile");
    await mkdir(profile, { recursive: true });
    const child = spawn(chrome, [
      "--remote-debugging-port=9222",
      `--user-data-dir=${profile}`,
      urls[platformName]
    ], { detached: true, stdio: "ignore" });
    child.unref();
    // 等 Chrome 启动
    await new Promise((r) => setTimeout(r, 3000));
  }

  return { mode: "browser", url: urls[platformName] };
}

export function stopDraftService() {
  if (serviceProcess && serviceProcess.exitCode == null) serviceProcess.kill("SIGTERM");
}
