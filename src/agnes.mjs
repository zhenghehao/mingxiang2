import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { CancelledError } from "./media.mjs";

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new CancelledError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function settings(config = {}) {
  const value = config.agnes || {};
  return {
    enabled: Boolean(value.enabled),
    baseUrl: String(value.baseUrl || "http://127.0.0.1:8899").replace(/\/$/, ""),
    projectRoot: value.projectRoot ? path.resolve(value.projectRoot) : "",
    timeoutMs: Math.max(60_000, Number(value.timeoutMs || 3_600_000)),
    fallbackToLibrary: value.fallbackToLibrary !== false,
    endFadeSeconds: Math.max(0, Number(value.endFadeSeconds ?? 5)),
    embedded: value.embedded !== false
  };
}

async function requestJson(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Agnes 服务返回 ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function health(baseUrl) {
  try {
    const payload = await requestJson(`${baseUrl}/bridge/health`, {}, 3_000);
    return payload.ok === true;
  } catch {
    return false;
  }
}

function launchDetached(command, args, cwd = undefined) {
  const child = spawn(command, args, { cwd, detached: true, stdio: "ignore" });
  child.unref();
}

async function ensureAgnesService(config) {
  const agnes = settings(config);
  if (await health(agnes.baseUrl)) return agnes;
  if (!agnes.projectRoot) throw new Error("Agnes 尚未运行，且眠屿没有配置 Agnes 项目路径");
  const serverFile = path.join(agnes.projectRoot, "cors-proxy.js");
  await access(serverFile);
  launchDetached(process.execPath, [serverFile], agnes.projectRoot);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await health(agnes.baseUrl)) return agnes;
    await sleep(500);
  }
  throw new Error("Agnes 服务启动失败；请先双击 Agnes 的 start.command，再续跑媒体阶段");
}

function openAgnesJob(agnes, jobId) {
  const url = `${agnes.baseUrl}/agnes-playground.html?bridgeJob=${encodeURIComponent(jobId)}`;
  launchDetached("/usr/bin/open", [url]);
}

function uiUrls(agnes, jobId = "") {
  const page = `${agnes.baseUrl}/agnes-playground.html`;
  const params = new URLSearchParams({ embedded: "1" });
  if (jobId) params.set("bridgeJob", jobId);
  return {
    uiUrl: page,
    embeddedUrl: `${page}?${params.toString()}`
  };
}

export function agnesVisualsEnabled(config) {
  return settings(config).enabled;
}

export function agnesFallbackEnabled(config) {
  return settings(config).fallbackToLibrary;
}

export function agnesEndFadeSeconds(config) {
  return settings(config).endFadeSeconds;
}

export async function inspectAgnes(config) {
  const agnes = settings(config);
  return {
    enabled: agnes.enabled,
    connected: agnes.enabled ? await health(agnes.baseUrl) : false,
    baseUrl: agnes.baseUrl,
    embedded: agnes.embedded,
    ...uiUrls(agnes)
  };
}

export async function createAgnesBridgeJob(config, { article, title = "" } = {}) {
  const agnes = await ensureAgnesService(config);
  const created = await requestJson(`${agnes.baseUrl}/bridge/jobs`, {
    method: "POST",
    body: JSON.stringify({ article, title })
  });
  const jobId = created.job?.id;
  if (!jobId) throw new Error("Agnes 没有返回任务编号");
  return { agnes, job: created.job, ...uiUrls(agnes, jobId) };
}

export async function generateAgnesVisuals(config, { article, title = "", onProgress, signal } = {}) {
  if (signal?.aborted) throw new CancelledError();
  const created = await createAgnesBridgeJob(config, { article, title });
  const { agnes } = created;
  const jobId = created.job.id;
  if (!agnes.embedded) openAgnesJob(agnes, jobId);
  onProgress?.({
    jobId,
    phase: "waiting",
    progress: 0,
    message: agnes.embedded ? "文稿已送入 Agnes，一体化视觉面板正在接管" : "文稿已送入 Agnes，正在打开视觉工作流"
  });

  const startedAt = Date.now();
  let lastFingerprint = "";
  while (Date.now() - startedAt < agnes.timeoutMs) {
    if (signal?.aborted) throw new CancelledError();
    const payload = await requestJson(`${agnes.baseUrl}/bridge/jobs/${encodeURIComponent(jobId)}`, {}, 10_000);
    const job = payload.job;
    if (!job) throw new Error("Agnes 任务记录丢失");
    const fingerprint = `${job.status}:${job.phase}:${job.progress}:${job.message || ""}`;
    if (fingerprint !== lastFingerprint) {
      onProgress?.({
        jobId,
        status: job.status,
        phase: job.phase,
        progress: Number(job.progress || 0),
        message: job.message || ""
      });
      lastFingerprint = fingerprint;
    }
    if (job.status === "completed") {
      const result = job.result || {};
      await Promise.all([access(result.coverPath), access(result.plainPath)]);
      return {
        jobId,
        coverPath: result.coverPath,
        loopPath: result.plainPath,
        selectedTitle: result.selectedTitle || "",
        selectedReason: result.selectedReason || ""
      };
    }
    if (job.status === "failed") throw new Error(job.error || "Agnes 视觉工作流失败");
    await sleep(2_500, signal);
  }
  throw new Error(`Agnes 视觉工作流等待超过 ${Math.round(agnes.timeoutMs / 60_000)} 分钟`);
}
