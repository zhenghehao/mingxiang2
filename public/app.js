const STAGES = [
  { id: "topic", slot: "topic", label: "选题", file: "01-选题结果.txt" },
  { id: "script", slot: "script", label: "催眠冥想原稿", file: "02-催眠冥想原稿.txt" },
  { id: "tts", slot: "ttsOptimizer", label: "MiniMax 配音文本", file: "03-MiniMax最终配音文本.txt" },
  { id: "copy", slot: "copywriter", label: "跨平台发布文案", file: "04-跨平台发布文案.txt" }
];

// 必须与 server.mjs 的 JOB_STEPS 一致。之前这里少了 cover 和 publish，
// 结果服务端跑 11 步、界面只画 9 步——封面和发布在界面上根本不存在。
const WORKFLOW_STEPS = [
  { id: "prepare", label: "检查历史选题", description: "扫描选题库并排除重复" },
  { id: "topic", label: "确定选题", description: "选择主题、时段与画面方向" },
  { id: "script", label: "创作原稿", description: "生成完整催眠冥想文稿" },
  { id: "tts", label: "优化配音文本", description: "整理停顿、语气与呼吸提示" },
  { id: "copy", label: "整理发布文案", description: "生成各平台标题、简介与标签" },
  { id: "cover", label: "生成封面图", description: "AI 生成 4:3 与 16:9 两张 B 站封面" },
  { id: "voice", label: "生成 AI 人声", description: "通过 MiniMax 合成助眠声音" },
  { id: "audio", label: "混合冥想音频", description: "加入背景音乐并处理音量" },
  { id: "video", label: "生成并导出视频", description: "Agnes 选景生成画面，动态封面后循环到音频结束" },
  { id: "files", label: "整理全部文件", description: "保存音频、视频、文本与清单" },
  { id: "publish", label: "准备平台草稿", description: "五个平台存草稿，两个音频平台停在人工确认前" }
];

/** 时长留空时的默认值，与 src/workflow.mjs 的 DEFAULT_DURATION_MINUTES 保持一致。 */
const DEFAULT_DURATION_MINUTES = 10;

/** 展开某一步时，从 text.json 的哪个字段取产物。 */
const STEP_ARTIFACT = {
  topic: { key: "topic", title: "选题结果" },
  script: { key: "script", title: "冥想原稿" },
  tts: { key: "optimized", title: "MiniMax 配音文本" },
  copy: { key: "copy", title: "各平台发布文案" }
};

/**
 * 每一步「重跑」的按钮文案与代价说明。
 *
 * ⚠️ affects 必须和 src/workflow.mjs 的 RERUN_PLAN 一致 —— 那张表是真正执行的
 * 依据，这里只是把它翻译成人话。两边不一致就等于向用户承诺后端不会做的事。
 * prepare 没有条目：它只是扫一遍选题库，单独重跑没有意义（要换选题就点选题那一步）。
 */
const RERUN_HINT = {
  topic:  { label: "重新选题", affects: ["原稿", "配音文本", "发布文案", "封面", "人声", "混音", "视频"], cost: "等于整条重跑，含 Agnes 画面，约 40–60 分钟", danger: true },
  script: { label: "重写原稿", affects: ["配音文本", "发布文案", "人声", "混音", "视频"], cost: "沿用选题；原稿变了 Agnes 画面也要重做，约 40 分钟", danger: true },
  tts:    { label: "重做配音文本", affects: ["发布文案", "人声", "混音", "视频"], cost: "文本一改人声必须重合成；Agnes 画面可复用，约 20 分钟", danger: true },
  copy:   { label: "重写发布文案", affects: [], cost: "只调一次文案 Skill，音频视频完全不动，一分钟内" },
  cover:  { label: "重新生成封面", affects: [], cost: "只重画两张 B 站封面，其余不动，约 40 秒" },
  voice:  { label: "重新合成人声", affects: ["混音", "视频"], cost: "消耗 MiniMax 额度；Agnes 画面复用，约 15 分钟", danger: true },
  audio:  { label: "重新混音", affects: ["视频"], cost: "重新随机一首 BGM；人声和画面都不动，重导视频约 12 分钟" },
  video:  { label: "重新生成画面", affects: [], cost: "Agnes 重跑一遍，约 20–40 分钟；音频完全不动", danger: true },
  files:  { label: "重新整理文件", affects: [], cost: "只重写清单和成品目录" },
  publish:{ label: "重新准备草稿", affects: [], cost: "重新生成草稿交接清单，不会正式发布" }
};

const DEFAULT_PROVIDER = {
  endpoint: "https://api.openai.com/v1/chat/completions",
  model: "",
  temperature: 0.7,
  authHeader: "Authorization",
  authPrefix: "Bearer ",
  responsePath: "choices.0.message.content"
};

const state = {
  config: null,
  skills: [],
  runtime: null,
  paths: null,
  baseline: {},
  outputs: {},
  stepStatus: {},
  draftSlots: {},
  mediaResult: null,
  minimaxAudioUrl: "",
  codexStatus: null,
  draftPublisherStatus: null,
  draftHandoff: null,
  draftJob: null,
  draftJobTimer: null,
  draftLoginSource: null,
  draftModalRunId: null,
  activeJob: null,
  selectedStep: "prepare",
  jobText: null,
  resumeCheck: null,
  resumableRuns: null,
  lastStageSignature: null,
  stageListPainted: false,
  followCurrentStep: true,
  pollToken: 0,
  completionNotifiedJobId: null,
  agnesFrameUrl: "",
  studioTab: "agnes"
};

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "请求失败");
    error.payload = payload;
    throw error;
  }
  return payload;
}

function emitStudioEvent(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function setStudioTab(tab) {
  state.studioTab = tab === "outputs" ? "outputs" : "agnes";
  document.querySelectorAll("[data-studio-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.studioTab === state.studioTab);
  });
  document.querySelectorAll(".studio-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `studio-${state.studioTab}`);
  });
  // 扫整个 output 目录算体积是有成本的，所以切到这个标签才读，不是一开页面就读
  if (state.studioTab === "outputs") loadOutputArchive();
}

function showVisualStudio(tab = "agnes") {
  setStudioTab(tab);
  const modal = $("visualModal");
  if (!modal.open) modal.showModal();
}

// 只关弹窗，绝不动 iframe 的 src —— Agnes 的生成逻辑跑在那个 iframe 里，
// 关闭后 <dialog> 只是 display:none，fetch/setTimeout 会继续，任务不中断。
function closeVisualStudio() {
  const modal = $("visualModal");
  if (modal.open) modal.close();
}

function loadAgnesPanel(jobId = "", force = false) {
  const runtime = state.runtime?.agnes;
  const configuredBase = state.config?.agnes?.baseUrl || "http://127.0.0.1:8899";
  const base = runtime?.embeddedUrl || `${configuredBase.replace(/\/$/, "")}/agnes-playground.html?embedded=1`;
  const url = new URL(base, window.location.href);
  url.searchParams.set("embedded", "1");
  if (jobId) url.searchParams.set("bridgeJob", jobId);
  else url.searchParams.delete("bridgeJob");
  const next = url.toString();
  if (!force && state.agnesFrameUrl === next) return;
  state.agnesFrameUrl = next;
  $("agnesFrameState").hidden = false;
  $("agnesFrame").src = next;
}

function syncAgnesPanel(job) {
  if (!job?.agnesJobId) return;
  const url = new URL(state.agnesFrameUrl || state.runtime?.agnes?.embeddedUrl || `${state.config?.agnes?.baseUrl}/agnes-playground.html?embedded=1`);
  if (url.searchParams.get("bridgeJob") === job.agnesJobId) return;
  // 只换 src 把任务挂上去，不弹窗 —— 弹窗会盖住流程看板，
  // 用户要看画面时自己点顶栏「Agnes 视觉」或视频那一步的按钮。
  loadAgnesPanel(job.agnesJobId);
}

window.SleepflowStudio = Object.freeze({
  version: "1.0",
  getState: () => JSON.parse(JSON.stringify({
    config: state.config,
    runtime: state.runtime,
    activeJob: state.activeJob,
    mediaResult: state.mediaResult
  })),
  on: (eventName, handler) => {
    window.addEventListener(eventName, handler);
    return () => window.removeEventListener(eventName, handler);
  },
  createWorkflow: (input) => api("/api/workflow/jobs", { method: "POST", body: JSON.stringify(input) }),
  createAgnesVisual: (input) => api("/api/agnes/jobs", { method: "POST", body: JSON.stringify(input) }),
  integrations: () => api("/api/integrations")
});

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 2800);
}

function openModal(id) {
  const modal = $(id);
  if (!modal.open) modal.showModal();
}

function savedProvider(stageId) {
  const configured = {
    endpoint: state.config?.textProvider?.baseUrl,
    model: state.config?.textProvider?.model,
    temperature: state.config?.textProvider?.temperature,
    responsePath: "choices.0.message.content",
    presetId: state.config?.textProvider?.presetId || ""
  };
  try {
    const stored = JSON.parse(localStorage.getItem(`sleepflowProvider:${stageId}`) || "{}");
    const matchingStored = stored.presetId && stored.presetId === configured.presetId ? stored : {};
    return { ...DEFAULT_PROVIDER, ...configured, ...matchingStored };
  } catch {
    return { ...DEFAULT_PROVIDER, ...configured };
  }
}

// 每个步骤那行里的「API Key」是**覆盖用**的，留空就走上面那把钥匙串里的共用 key。
// 说明写在占位符里，免得又出现「以为填了其实没存」那种事。
function renderProviderSettings() {
  $("providerSettings").innerHTML = STAGES.map((stage, index) => {
    const provider = savedProvider(stage.id);
    return `
      <div class="provider-row" data-provider="${stage.id}">
        <div class="provider-head">
          <strong>${String(index + 1).padStart(2, "0")} · ${stage.label}</strong>
          <span>${escapeHtml(state.skills.find((item) => item.id === state.config.slots[stage.slot])?.name || "未绑定 Skill")}</span>
        </div>
        <div class="provider-fields">
          <label>接口地址<input data-field="endpoint" value="${escapeHtml(provider.endpoint)}"></label>
          <label>模型<input data-field="model" value="${escapeHtml(provider.model)}" placeholder="模型 ID"></label>
          <label>API Key<input data-field="apiKey" type="password" autocomplete="off" placeholder="留空＝用上面那把共用 Key"></label>
          <label>温度<input data-field="temperature" type="number" min="0" max="2" step="0.1" value="${escapeHtml(provider.temperature)}"></label>
          <button class="button quiet" data-test-provider="${stage.id}">测试</button>
        </div>
        <input data-field="authHeader" type="hidden" value="${escapeHtml(provider.authHeader)}">
        <input data-field="authPrefix" type="hidden" value="${escapeHtml(provider.authPrefix)}">
        <input data-field="responsePath" type="hidden" value="${escapeHtml(provider.responsePath)}">
        <div class="api-test-state" id="provider-state-${stage.id}">未测试</div>
      </div>`;
  }).join("");

  document.querySelectorAll("[data-provider]").forEach((row) => {
    row.addEventListener("input", (event) => {
      if (event.target.dataset.field !== "apiKey") persistProvider(row.dataset.provider);
    });
  });
}

function providerFromRow(stageId) {
  const row = document.querySelector(`[data-provider="${stageId}"]`);
  const value = (field) => row.querySelector(`[data-field="${field}"]`).value;
  return {
    endpoint: value("endpoint").trim(),
    model: value("model").trim(),
    apiKey: value("apiKey").trim(),
    temperature: Number(value("temperature") || 0.7),
    authHeader: value("authHeader").trim() || "Authorization",
    authPrefix: value("authPrefix"),
    responsePath: value("responsePath").trim()
  };
}

function persistProvider(stageId) {
  const provider = providerFromRow(stageId);
  delete provider.apiKey;
  provider.presetId = state.config?.textProvider?.presetId || "";
  localStorage.setItem(`sleepflowProvider:${stageId}`, JSON.stringify(provider));
}

function allProviders() {
  return Object.fromEntries(STAGES.map((stage) => [stage.id, providerFromRow(stage.id)]));
}

function currentTextEngineMode() {
  return document.querySelector('input[name="textEngineMode"]:checked')?.value
    || state.config?.textEngine?.mode
    || "codex-cli";
}

function codexSettingsFromForm() {
  return {
    path: $("codexPath").value.trim() || "auto",
    model: document.querySelector('input[name="codexModel"]:checked')?.value || "gpt-5.6-sol",
    reasoningEffort: $("codexReasoning").value || "high",
    timeoutMs: Number(state.config?.textEngine?.codexCli?.timeoutMs || 900000)
  };
}

function renderTextEngineMode(modeOverride) {
  const mode = modeOverride || state.config?.textEngine?.mode || "codex-cli";
  const radio = document.querySelector(`input[name="textEngineMode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  $("codexCliPanel").hidden = mode !== "codex-cli";
  $("apiProviderPanel").hidden = mode !== "api";
  const model = state.config?.textEngine?.codexCli?.model || "gpt-5.6-sol";
  const apiModel = state.config?.textProvider?.model || "自定义模型";
  $("activeTextEngine").textContent = mode === "codex-cli" ? `Codex CLI · ${model}` : `API · ${apiModel}`;
}

function showCodexStatus(status) {
  state.codexStatus = status;
  const connected = Boolean(status?.connected);
  $("codexStatusDot").classList.toggle("ready", connected);
  $("codexStatusTitle").textContent = connected
    ? `Codex CLI 已连接 · ${status.version}`
    : (status?.available ? "已找到 CLI，但尚未登录" : "没有找到 Codex CLI");
  $("codexStatusDetail").textContent = status?.path
    ? `${status.path} · ${status.authStatus || "状态未知"}`
    : (status?.authStatus || "可以填写路径后重新检测");
}

const DRAFT_STATE_TEXT = {
  queued: "等待",
  processing: "处理中",
  draft_saved: "已存草稿",
  prepared_for_manual_review: "已准备人工确认",
  published: "已发布",
  needs_login: "需要登录",
  failed: "失败",
  running: "处理中",
  success: "全部完成",
  partial: "部分完成"
};

function showDraftPublisherStatus(status) {
  state.draftPublisherStatus = status;
  const connected = Boolean(status?.connected);
  $("publishingTopDot").classList.toggle("ready", connected);
  $("publishingTopText").textContent = connected ? "平台草稿已就绪" : "平台草稿";
  $("draftServiceDot").classList.toggle("ready", connected);
  $("draftServiceTitle").textContent = connected ? "内嵌草稿服务已连接" : "草稿服务暂未连接";
  $("draftServiceDetail").textContent = connected
    ? `固定浏览器${status.cdp ? "已连接" : "待打开"} · 七个平台均禁止自动正式发布`
    : (status?.error || "正在启动内嵌运行环境");
  $("draftDebug").textContent = JSON.stringify({
    connected,
    serviceUrl: status?.serviceUrl || "",
    browserConnected: Boolean(status?.cdp),
    platforms: (status?.platforms || []).map((item) => ({
      platform: item.label,
      login: item.login,
      accounts: (item.accounts || []).map((account) => ({
        name: account.name,
        status: account.status,
        loginMode: account.loginMode
      }))
    }))
  }, null, 2);
  if (state.draftHandoff) renderDraftPlatforms();
}

function draftStatusFor(name) {
  return state.draftPublisherStatus?.platforms?.find((item) => item.name === name);
}

function renderDraftPlatforms() {
  const handoff = state.draftHandoff;
  if (!handoff) return;
  $("draftPlatformCount").textContent = `${handoff.platforms.length} 个平台 · 可分别取消勾选`;
  $("draftPlatformList").innerHTML = handoff.platforms.map((platform) => {
    const login = draftStatusFor(platform.name);
    const loggedIn = login?.login === "ok";
    const result = state.draftJob?.results?.find((item) => item.platform === platform.name);
    const mode = platform.kind === "audio"
      ? "上传并填表，等待人工确认"
      : (platform.name === "bilibili" ? "保存草稿，再预选健康分类" : "只保存草稿");
    return `<article class="draft-platform-card ${result ? `state-${escapeHtml(result.state)}` : ""}">
      <div class="draft-platform-head">
        <label><input class="draft-platform-check" type="checkbox" value="${escapeHtml(platform.name)}" checked>
          <strong>${escapeHtml(platform.label)}</strong></label>
        <span class="account-state ${loggedIn ? "" : "offline"}">${loggedIn ? "登录态可用" : "需要检查登录"}</span>
      </div>
      <small class="draft-platform-mode">${escapeHtml(mode)}</small>
      <details>
        <summary>${escapeHtml(platform.copy.title || "查看平台文案")}</summary>
        <div class="draft-copy">
          <strong>标题</strong><p>${escapeHtml(platform.copy.title)}</p>
          <strong>简介</strong><p>${escapeHtml(platform.copy.description || "（无简介）")}</p>
          <strong>标签</strong><p>${escapeHtml((platform.copy.tags || []).join(" · ") || "（无标签）")}</p>
        </div>
      </details>
      <div class="draft-platform-foot">
        <span>${result ? escapeHtml(DRAFT_STATE_TEXT[result.state] || result.state) : "等待操作"}</span>
        ${result?.message ? `<small>${escapeHtml(result.message)}</small>` : ""}
        ${loggedIn ? "" : `<button class="button quiet" data-draft-login="${escapeHtml(platform.name)}">打开登录</button>`}
      </div>
    </article>`;
  }).join("");
  syncDraftSelection();
}

function syncDraftSelection() {
  const checks = [...document.querySelectorAll(".draft-platform-check")];
  const selected = checks.filter((check) => check.checked).length;
  $("draftSelectAll").checked = Boolean(checks.length) && selected === checks.length;
  $("draftSelectAll").indeterminate = selected > 0 && selected < checks.length;
  const jobRunning = ["queued", "running"].includes(state.draftJob?.state);
  const notReady = !state.draftHandoff?.ready;
  const noSelection = !selected;
  $("savePlatformDrafts").disabled = notReady || noSelection || jobRunning;
  // 按钮灰掉时告诉用户具体原因
  let title, hint;
  if (notReady) {
    const missing = state.draftHandoff?.missing?.length
      ? `缺少${state.draftHandoff.missing.join("、")}` : "成品文件不完整";
    title = `无法存草稿：${missing}`;
    hint = "请先完成完整工作流（含视频、音频、封面），再回来存草稿。";
  } else if (jobRunning) {
    title = "正在处理中，请等待完成";
    hint = "当前已有草稿任务在运行，完成后可再次提交。";
  } else if (noSelection) {
    title = "请至少勾选一个平台";
    hint = "取消勾选的平台不会被处理。";
  } else {
    title = `已选择 ${selected} 个平台`;
    hint = "点击后会将选中平台的素材和文案提交到草稿箱，不会自动发布。";
  }
  $("draftActionTitle").textContent = title;
  $("draftActionHint").textContent = hint;
}

async function setDraftAssets(runId) {
  const root = `/api/draft-publisher/runs/${encodeURIComponent(runId)}/assets`;
  $("draftVideoPreview").src = `${root}/video`;
  $("draftAudioPreview").src = `${root}/audio`;
  $("draftCover4x3").src = `${root}/cover4x3`;
  $("draftCover16x9").src = `${root}/cover16x9`;
  $("draftAssets").hidden = false;
  $("downloadBundle").href = `/api/draft-publisher/runs/${encodeURIComponent(runId)}/bundle`;
  $("draftDownloadBar").hidden = false;

  // 文案 txt 直接把开头几行读出来贴在卡片里 —— 光给个链接，
  // 十次里有九次还得点开才知道生成得对不对。
  const preview = $("draftCopyPreview");
  $("draftCopyOpen").href = `${root}/copytxt`;
  try {
    const response = await fetch(`${root}/copytxt`);
    if (!response.ok) throw new Error(`读取失败（${response.status}）`);
    const text = await response.text();
    preview.textContent = text.slice(0, 600);
    // 顺手数一下七个标题有没有重复。04 用 flash 时偶尔会撞标题且不报错，
    // 与其等用户自己发现，不如在这儿直接说。
    const titles = [...text.matchAll(/── 标题 ──\n(.+)/g)].map((m) => m[1].trim());
    const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
    const badge = $("draftCopyBadge");
    if (badge) {
      badge.textContent = dupes.length
        ? `⚠ 有 ${new Set(dupes).size} 个标题重复`
        : `${titles.length} 个平台，标题都不同`;
      badge.className = dupes.length ? "copy-badge warn" : "copy-badge";
    }
  } catch (error) {
    preview.textContent = `没读到文案 txt：${error.message}\n（这次运行可能是旧版本生成的，重跑一次就有了）`;
  }
}

async function refreshDraftStatus() {
  const button = $("refreshDraftStatus");
  button.disabled = true;
  try {
    showDraftPublisherStatus(await api("/api/draft-publisher/status"));
  } finally {
    button.disabled = false;
  }
}

async function openDraftModal(runId = state.activeJob?.runId) {
  openModal("publishingModal");
  // 发布那一块由配置控制显隐。关掉时这个弹窗就只是「本次成品」——
  // 预览四样产物 + 打包下载，不碰任何平台。
  const showPublishing = state.config?.publishing?.uiEnabled === true;
  for (const el of [$("publishingSection"), ...document.querySelectorAll(".publishing-only")]) {
    if (el) el.hidden = !showPublishing;
  }
  const label = $("draftRunLabel");
  if (label && !showPublishing) label.dataset.mode = "assets-only";
  if (showPublishing) $("draftPlatformList").innerHTML = '<div class="output-empty">正在读取工作流产物和登录状态…</div>';
  $("draftPlatformList").innerHTML = '<div class="output-empty">正在读取工作流产物和登录状态…</div>';
  if (!runId) {
    try {
      const latest = await api("/api/draft-publisher/runs/latest");
      runId = latest.handoff.runId;
    } catch {
      if (showPublishing) {
        $("draftActionTitle").textContent = "请先完成一次工作流";
        await refreshDraftStatus();
      }
      return;
    }
  }
  state.draftModalRunId = runId;
  $("draftRunLabel").textContent = `运行编号：${runId}`;
  try {
    const [payload, status] = await Promise.all([
      api(`/api/draft-publisher/runs/${encodeURIComponent(runId)}/payload`),
      api("/api/draft-publisher/status")
    ]);
    state.draftHandoff = payload.handoff;
    await setDraftAssets(runId);
    if (!showPublishing) return;
    showDraftPublisherStatus(status);
    renderDraftPlatforms();
    const previous = await api(
      `/api/draft-publisher/jobs/latest?runId=${encodeURIComponent(runId)}`
    ).catch(() => null);
    if (previous?.job) renderDraftJob(previous.job);
  } catch (error) {
    if (showPublishing) {
      $("draftPlatformList").innerHTML = `<div class="output-empty">${escapeHtml(error.message)}</div>`;
      $("draftActionTitle").textContent = "无法读取草稿交接清单";
    }
    toast(error.message);
  }
}

async function openDraftLogin(platform) {
  const result = await api(`/api/draft-publisher/platforms/${encodeURIComponent(platform)}/open-login`, {
    method: "POST",
    body: "{}"
  }).catch((error) => {
    toast(`打开登录失败：${error.message}`);
    throw error;
  });
  $("draftLoginPanel").hidden = false;
  $("draftLoginTitle").textContent = `${draftStatusFor(platform)?.label || platform}登录`;
  $("draftLoginQr").hidden = true;
  if (state.draftLoginSource) state.draftLoginSource.close();
  if (result.mode === "browser") {
    // B站(5)/喜马拉雅(6)/网易云(7) 走 Chrome 9222 模式
    $("draftLoginHint").textContent = "正在启动浏览器打开平台创作后台…";
    // 轮询检测 Chrome 9222 是否就绪，最多等 15 秒（通过后端代理避免 CORS）
    const expectedUrls = { bilibili: "member.bilibili.com", ximalaya: "studio.ximalaya.com", netease: "music.163.com" };
    const expectedUrl = expectedUrls[platform] || "";
    let cdpReady = false;
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const cdpResult = await api("/api/draft-publisher/cdp-check");
        if (cdpResult.connected) {
          const found = cdpResult.pages?.some((p) => expectedUrl && String(p.url || "").includes(expectedUrl));
          if (found) {
            cdpReady = true;
            $("draftLoginHint").textContent = "已打开平台创作后台（Chrome 已连接）。请在 Chrome 窗口中登录或确认登录态，完成后点“重新检测”。";
            break;
          }
          cdpReady = true;
          $("draftLoginHint").textContent = "Chrome 已启动，正在加载平台页面…";
        }
      } catch {
        // 后端请求失败，继续等
      }
    }
    if (!cdpReady) {
      $("draftLoginHint").innerHTML = `Chrome 浏览器未能自动启动（端口 9222 无响应）。<br>请手动打开 Chrome 后点“重新检测”，或检查是否安装了 Google Chrome。`;
    } else if (!$("draftLoginHint").textContent.includes("已打开")) {
      $("draftLoginHint").textContent = "Chrome 已启动，请在 Chrome 窗口中登录平台，完成后点“重新检测”。";
    }
    return;
  }
  $("draftLoginHint").textContent = "请使用对应平台 App 扫码。不会绕过验证码或平台风控。";
  const source = new EventSource(result.eventSourceUrl);
  state.draftLoginSource = source;
  source.onmessage = (event) => {
    if (event.data === "200") {
      source.close();
      state.draftLoginSource = null;
      $("draftLoginHint").textContent = "登录成功，正在刷新状态…";
      refreshDraftStatus().catch((error) => toast(error.message));
    } else if (event.data === "500") {
      source.close();
      state.draftLoginSource = null;
      $("draftLoginHint").textContent = "登录没有完成，请重新打开登录。";
    } else if (event.data.length > 100) {
      $("draftLoginQr").src = event.data.startsWith("data:image")
        ? event.data : `data:image/png;base64,${event.data}`;
      $("draftLoginQr").hidden = false;
    }
  };
  source.onerror = () => {
    $("draftLoginHint").textContent = "登录窗口连接中断，可以重新检测登录状态。";
    source.close();
    state.draftLoginSource = null;
  };
}

function renderDraftJob(job) {
  state.draftJob = job;
  $("draftJobPanel").hidden = false;
  $("draftJobState").textContent = DRAFT_STATE_TEXT[job.state] || job.state;
  $("draftJobResults").innerHTML = job.results.map((result) => `
    <div class="platform-row ${escapeHtml(result.state)}">
      <span class="platform-name">${escapeHtml(result.label)}</span>
      <span class="platform-state">${escapeHtml(DRAFT_STATE_TEXT[result.state] || result.state)}</span>
      <span class="platform-msg">${escapeHtml(result.message || "等待处理")}</span>
    </div>`).join("");
  renderDraftPlatforms();
  syncDraftSelection();
}

async function monitorDraftJob(jobId) {
  clearInterval(state.draftJobTimer);
  const poll = async () => {
    const payload = await api(`/api/draft-publisher/jobs/${encodeURIComponent(jobId)}`);
    renderDraftJob(payload.job);
    if (!["queued", "running"].includes(payload.job.state)) {
      clearInterval(state.draftJobTimer);
      state.draftJobTimer = null;
      toast(payload.job.state === "success" ? "草稿交接已完成" : "部分平台需要处理");
    }
  };
  await poll();
  if (["queued", "running"].includes(state.draftJob?.state)) {
    state.draftJobTimer = setInterval(() => poll().catch((error) => toast(error.message)), 2_000);
  }
}

async function savePlatformDrafts() {
  const platforms = [...document.querySelectorAll(".draft-platform-check:checked")].map((check) => check.value);
  if (!state.draftModalRunId || !platforms.length) return;
  const button = $("savePlatformDrafts");
  button.disabled = true;
  const payload = await api("/api/draft-publisher/jobs", {
    method: "POST",
    body: JSON.stringify({ runId: state.draftModalRunId, platforms })
  });
  renderDraftJob(payload.job);
  await monitorDraftJob(payload.job.id);
}

function fillCodexSettings() {
  const status = state.runtime?.codex || {};
  const settings = state.config?.textEngine?.codexCli || {};
  const models = status.models || [];
  const selectedModel = settings.model || "gpt-5.6-sol";
  $("codexModel").innerHTML = models.map((model) =>
    `<label class="codex-model-option">
      <input type="radio" name="codexModel" value="${escapeHtml(model.id)}" ${model.id === selectedModel ? "checked" : ""}>
      <span><strong>${escapeHtml(model.label)}</strong><code>${escapeHtml(model.id)}</code><small>${escapeHtml(model.description)}</small></span>
    </label>`
  ).join("");
  $("codexReasoning").value = settings.reasoningEffort || "high";
  $("codexPath").value = settings.path === "auto" ? "" : (settings.path || "");
  showCodexStatus(status);
  renderTextEngineMode();
}

function renderRoots() {
  $("rootList").innerHTML = state.config.skillRoots.map((root, index) => `
    <div class="root-pill"><span>${escapeHtml(root)}</span><button data-remove-root="${index}">×</button></div>
  `).join("");
}

function renderSlots() {
  const names = {
    topic: "选题 Skill",
    script: "文稿 Skill",
    ttsOptimizer: "配音优化 Skill",
    copywriter: "发布文案 Skill"
  };
  const options = state.skills.map((skill) => `<option value="${skill.id}">${escapeHtml(skill.name)}</option>`).join("");
  $("slotBindings").innerHTML = Object.entries(names).map(([slot, label]) => `
    <label>${label}<select data-slot="${slot}"><option value="">未绑定</option>${options}</select></label>
  `).join("");
  state.draftSlots = { ...state.config.slots };
  document.querySelectorAll("[data-slot]").forEach((select) => {
    select.value = state.config.slots[select.dataset.slot] || "";
    select.addEventListener("change", () => { state.draftSlots[select.dataset.slot] = select.value || null; });
  });
}

function renderSkills() {
  $("skillList").innerHTML = state.skills.length ? state.skills.map((skill) => `
    <div class="library-row">
      <div><strong>${escapeHtml(skill.name)}</strong><span>${escapeHtml(skill.file)}</span></div>
      <code>${escapeHtml(skill.version)}</code>
    </div>
  `).join("") : `<div class="output-empty">没有找到 Skill</div>`;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function loadMediaLibrary(type) {
  const payload = await api(`/api/library/media?type=${type}`);
  $(`${type}Count`).textContent = `${payload.files.length} 个文件`;
  $(`${type}List`).innerHTML = payload.files.length ? payload.files.map((file) => `
    <div class="library-row">
      <div><strong>${escapeHtml(file.name)}</strong><span>${escapeHtml(file.relativePath)}</span></div>
      <code>${formatSize(file.size)}</code>
    </div>
  `).join("") : `<div class="output-empty">${payload.root ? "文件夹中没有可用素材" : "尚未设置文件夹"}</div>`;
}

async function saveMediaRoot(type, root) {
  const key = type === "bgm" ? "bgmRoot" : "videoRoot";
  const payload = await api("/api/config", {
    method: "PUT",
    body: JSON.stringify({ media: { [key]: root } })
  });
  state.config = payload.config;
  $(key).value = payload.config.media[key];
  await loadMediaLibrary(type);
}

async function chooseMediaRoot(button) {
  const type = button.dataset.chooseMedia;
  const label = type === "bgm" ? "背景音乐" : "视频素材";
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "选择中…";
  try {
    const selection = await api("/api/dialog/select-directory", {
      method: "POST",
      body: JSON.stringify({ type })
    });
    if (selection.cancelled) return toast("已取消选择");
    await saveMediaRoot(type, selection.path);
    toast(`${label}文件夹已保存`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

const STEP_STATUS_TEXT = { idle: "等待", running: "进行中", done: "已完成", error: "失败", cancelled: "已取消" };

function workflowSteps() {
  return state.activeJob?.steps || WORKFLOW_STEPS.map((step) => ({ ...step, status: "idle", message: "等待开始", detail: "" }));
}

/** 每步的产物文本缓存：jobId -> text.json */
const jobTextCache = new Map();

async function loadJobText(jobId) {
  if (!jobId) return null;
  if (jobTextCache.has(jobId)) return jobTextCache.get(jobId);
  try {
    const resp = await fetch(`/api/workflow/jobs/${encodeURIComponent(jobId)}/text`);
    if (!resp.ok) return null;
    const data = await resp.json();
    jobTextCache.set(jobId, data.text || null);
    return data.text || null;
  } catch {
    return null;
  }
}

function asText(value) {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function renderPublishPanel(step) {
  const runId = state.activeJob?.runId;
  return `<div class="stage-actions">
    <button class="button primary" id="stageOpenPublishStatus"${runId ? "" : " disabled"}>检查并存入草稿</button>
    <small>五个视频平台只保存草稿；两个音频平台停在人工确认前。</small>
  </div>
  <div class="manual-box">
    <strong>安全边界</strong>
    <div class="manual-row"><span>不会正式发布</span><small>工作流完成只打开检查窗口，必须由你手动点击一次才开始处理。</small></div>
    <div class="manual-row"><span>B站健康分类</span><small>保存草稿后重新打开并预选“健康”，保留编辑页给你检查。</small></div>
  </div>`;
}

/** 成品文件（音频 / 视频）。 */
function renderFilesPanel() {
  const media = state.mediaResult?.media;
  if (!media?.outputAudio && !media?.outputVideo) {
    return `<div class="stage-empty">还没有成品文件</div>`;
  }
  const rows = [];
  if (media.outputAudio) {
    rows.push(`<div class="file-row"><div><strong>合成音频.mp3</strong><small>${formatSize(media.outputAudioSize || 0)}</small></div>
      <div class="file-actions"><button data-open-file="${escapeHtml(media.outputAudio)}">播放</button><button data-reveal-file="${escapeHtml(media.outputAudio)}">位置</button></div></div>`);
  }
  if (media.outputVideo) {
    const p = media.videoProfile;
    const detail = p ? `${p.width}×${p.height} · ${formatSize(media.outputVideoSize || 0)}` : formatSize(media.outputVideoSize || 0);
    rows.push(`<div class="file-row"><div><strong>成品视频.mp4</strong><small>${detail}</small></div>
      <div class="file-actions"><button data-open-file="${escapeHtml(media.outputVideo)}">播放</button><button data-reveal-file="${escapeHtml(media.outputVideo)}">位置</button></div></div>`);
  }
  return rows.join("");
}

/**
 * 某一步的「重跑」条。
 *
 * 只在这次运行已经写过盘（有 runId）、且没有任务正在跑的时候给出来 ——
 * 一边跑一边重跑同一个运行目录会互相覆盖文件。
 * 按钮上写清会连带重做什么，让人在点之前就知道代价，而不是点完才发现
 * 又要等 40 分钟。
 */
function renderRerunBar(step) {
  const hint = RERUN_HINT[step.id];
  const job = state.activeJob;
  if (!hint || !job?.runId) return "";
  if (step.status === "idle") return "";

  const busy = job.status === "running" || job.status === "queued";
  const chain = hint.affects.length
    ? `连带重做：${hint.affects.join(" → ")}`
    : "不影响其它步骤";
  return `<div class="rerun-bar${hint.danger ? " danger" : ""}">
    <div><strong>${escapeHtml(chain)}</strong><small>${escapeHtml(hint.cost)}</small></div>
    <button class="button" data-rerun-step="${escapeHtml(step.id)}"${busy ? " disabled" : ""}>${
      busy ? "任务进行中" : escapeHtml(hint.label)
    }</button>
  </div>`;
}

/** 某一步展开后的内容。 */
function renderStagePanel(step) {
  const job = state.activeJob;
  const rerun = renderRerunBar(step);

  if (step.id === "publish") return rerun + renderPublishPanel(step);
  if (step.id === "files") return rerun + renderFilesPanel();

  if (step.id === "video") {
    return rerun + `<div class="stage-actions">
      <button class="button primary" id="stageOpenAgnes">打开 Agnes 视觉面板</button>
      <small>画面由 Agnes 生成；这一步耗时最长，可以先去做别的。</small>
    </div>` + renderStageEvents(step, job);
  }

  const artifact = STEP_ARTIFACT[step.id];
  if (artifact) {
    const text = state.jobText?.[artifact.key];
    if (text) {
      return rerun + `<div class="artifact"><div class="artifact-head">${escapeHtml(artifact.title)}
        <button class="text-button" data-copy-artifact="${escapeHtml(artifact.key)}">复制</button></div>
        <pre>${escapeHtml(asText(text))}</pre></div>`;
    }
  }
  return rerun + renderStageEvents(step, job);
}

function renderStageEvents(step, job) {
  const events = (job?.events || []).filter((e) => e.step === step.id).slice().reverse();
  if (!events.length) {
    return `<div class="stage-empty">${step.status === "idle" ? "这一步还没有开始" : "正在读取实时过程…"}</div>`;
  }
  return `<div class="stage-events">${events.map((e) => `
    <div class="stage-event ${e.status}">
      <time>${new Date(e.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
      <div><strong>${escapeHtml(e.message || step.label)}</strong>${e.detail ? `<span>${escapeHtml(e.detail)}</span>` : ""}</div>
    </div>`).join("")}</div>`;
}

/**
 * 步骤列表的内容指纹。
 *
 * monitorJob 每 900ms 轮询一次并调用本函数，但任务状态往往几十秒才变一次。
 * 每次都重建 innerHTML 会：重播卡片入场动画（表现为整屏闪烁）、
 * 清掉展开卡片里 <pre> 的滚动位置、白白烧 CPU。
 * 指纹没变就直接跳过重渲染。
 */
function stageSignature(job, steps, progress) {
  return JSON.stringify([
    progress,
    state.selectedStep,
    // status / runId 决定「重跑」按钮是可点还是灰的，漏了它按钮会一直停在
    // 任务刚开始时的状态
    job?.status || "",
    job?.runId || "",
    steps.map((s) => [s.id, s.status, s.message, s.detail]),
    state.jobText ? Object.keys(state.jobText).join(",") : "",
    state.mediaResult?.media?.outputVideo || ""
  ]);
}

/**
 * 有任务在手时把整块输入区收起来，只留一条摘要 —— 那一大块占掉的纵向空间
 * 应该给下面的流程图。点「新任务」（侧栏或摘要条上）才会重新展开。
 * 放在 stageSignature 提前 return 之前，否则任务刚建好那一帧收不起来。
 */
function syncComposer() {
  const job = state.activeJob;
  const composer = document.querySelector(".composer");
  const summary = $("composerSummary");
  if (!composer || !summary) return;
  composer.classList.toggle("collapsed", Boolean(job));
  summary.hidden = !job;
  if (!job) return;
  const period = job.brief || $("brief").value || "晚上";
  const minutes = Number(job.durationMinutes) || Number($("runDuration").value) || 10;
  const label = {
    queued: "排队中", running: "生成中", completed: "已完成",
    failed: "已中断", error: "已中断", cancelled: "已取消"
  }[job.status] || job.status;
  $("composerSummaryText").textContent =
    `${job.date || $("runDate").value} · ${period} · ${minutes} 分钟 · ${label}`;
  // 只有还在跑的任务才给取消。cancellable 由后端算，前端不自己判断状态集合，
  // 免得两边对「什么算终态」的理解漂移。
  const cancel = $("cancelJob");
  if (cancel) cancel.hidden = job.cancellable === false;
}

function renderWorkflowProgress() {
  const job = state.activeJob;
  const steps = workflowSteps();
  const progress = Number(job?.progress || 0);

  syncComposer();

  const signature = stageSignature(job, steps, progress);
  if (signature === state.lastStageSignature) {
    refreshResumeBar();
    return;
  }
  state.lastStageSignature = signature;

  $("boardProgressText").textContent = `${progress}%`;
  $("boardProgressBar").style.width = `${progress}%`;
  const running = steps.find((s) => s.status === "running");
  const doneCount = steps.filter((s) => s.status === "done").length;
  $("boardSubtitle").textContent = job
    ? (running ? `正在：${running.label}` : `已完成 ${doneCount}/${steps.length} 步`)
    : "还没有开始生成 · 填好下方信息即可开工";

  $("stageList").innerHTML = steps.map((step, index) => {
    const open = step.id === state.selectedStep;
    const marker = step.status === "done" ? "✓" : (step.status === "error" ? "!" : String(index + 1));
    return `<section class="stage ${step.status} ${open ? "open" : ""}">
      <button class="stage-head" data-select-step="${escapeHtml(step.id)}" aria-expanded="${open}">
        <span class="stage-marker">${marker}</span>
        <span class="stage-title">
          <strong>${escapeHtml(step.label)}</strong>
          <small>${escapeHtml(step.message || step.description || "等待开始")}</small>
        </span>
        <span class="stage-status">${escapeHtml(STEP_STATUS_TEXT[step.status] || "等待")}</span>
        <span class="stage-caret">${open ? "▾" : "▸"}</span>
      </button>
      ${open ? `<div class="stage-body">${renderStagePanel(step)}</div>` : ""}
    </section>`;
  }).join("");

  // 入场动画只在第一次绘制时播；之后每次轮询重渲染都不再重放（否则整屏闪烁）
  const list = $("stageList");
  if (!state.stageListPainted) {
    state.stageListPainted = true;
    list.classList.add("first-paint");
    setTimeout(() => list.classList.remove("first-paint"), 700);
  }

  renderRailOutputs();
  refreshResumeBar();
}

/**
 * 失败任务的「继续」按钮。
 *
 * 续跑只在文本和人声都已落盘时可行 —— 那是最贵的两步（MiniMax 额度、
 * Agnes 几十分钟）。挂在文本阶段时后端会明确说不能续，这里如实显示原因，
 * 不给一个点了才报错的按钮。
 */
async function refreshResumeBar() {
  const bar = $("resumeBar");
  if (!bar) return;
  const job = state.activeJob;

  // 没有活动任务时，去磁盘上找中断的运行。
  // 任务记录只在内存里，服务重启就没了，但 work/runs 下的产物还在 ——
  // 之前重启后「明明文件都在却续不了」就是因为只认内存任务。
  if (!job) {
    if (!state.resumableRuns) {
      try {
        const resp = await fetch("/api/workflow/resumable-runs");
        state.resumableRuns = (await resp.json()).runs || [];
      } catch {
        state.resumableRuns = [];
      }
      renderResumableRuns();
    }
    bar.hidden = true;
    return;
  }

  if (job.status !== "failed") { bar.hidden = true; return; }

  let check = state.resumeCheck;
  if (!check || check.jobId !== job.id) {
    try {
      const resp = await fetch(`/api/workflow/jobs/${encodeURIComponent(job.id)}/resumable`);
      check = { ...(await resp.json()), jobId: job.id };
    } catch {
      check = { ok: false, reason: "无法连接本地服务", jobId: job.id };
    }
    state.resumeCheck = check;
  }

  bar.hidden = false;
  bar.className = `resume-bar ${check.ok ? "can-resume" : "cannot"}`;
  bar.innerHTML = check.ok
    ? `<div><strong>这次没跑完</strong><small>${escapeHtml(check.label || "可以从中断处继续")}</small></div>
       <button class="button primary" id="doResume">继续</button>`
    : `<div><strong>这次没跑完</strong><small>${escapeHtml(check.reason || "只能重新生成")}</small></div>`;
}

/** 把磁盘上中断的运行列在看板顶部，每条给一个「继续」。 */
function renderResumableRuns() {
  const box = $("resumableRuns");
  if (!box) return;
  const runs = state.resumableRuns || [];
  if (!runs.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = `<div class="resumable-head">有 ${runs.length} 次生成没跑完，可以接着跑</div>` +
    runs.map((run) => {
      const when = run.updatedAt
        ? new Date(run.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        : run.date;
      return `<div class="resumable-row">
        <div>
          <strong>${escapeHtml(run.title || run.runId)}</strong>
          <small>${escapeHtml(when)} · ${escapeHtml(run.label)}</small>
        </div>
        <div class="resumable-actions">
          <button class="button primary" data-resume-run="${escapeHtml(run.runId)}">继续</button>
          <button class="button quiet" data-discard-run="${escapeHtml(run.runId)}"
            title="从列表里移除，文件保留在磁盘上">丢弃</button>
        </div>
      </div>`;
    }).join("");
}

function renderRailOutputs() {
  const el = $("railOutputs");
  if (!el) return;
  const media = state.mediaResult?.media;
  const items = [];
  if (media?.outputAudio) items.push("音频 mp3");
  if (media?.outputVideo) items.push("视频 mp4");
  if (state.draftJob?.results?.length) {
    // 音频是真发出去了，视频是进草稿箱，两者分开数，不能混成一句「草稿已准备」
    const drafted = state.draftJob.results.filter((item) =>
      ["draft_saved", "prepared_for_manual_review"].includes(item.state)
    ).length;
    const published = state.draftJob.results.filter((item) => item.state === "published").length;
    if (drafted) items.push(`草稿已准备 ${drafted} 个平台`);
    if (published) items.push(`已发布 ${published} 个平台`);
  }
  el.innerHTML = items.length ? items.map((t) => `<span class="rail-chip">${escapeHtml(t)}</span>`).join("") : "<small>还没有成品</small>";
}

function outputText(stageId) {
  const value = state.outputs[stageId];
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function renderOutputs() {
  const mediaItems = [];
  if (state.mediaResult?.media?.outputAudio) {
    const media = state.mediaResult.media;
    mediaItems.push(`<div class="output-item"><div><strong>合成音频.mp3</strong><span>${formatSize(media.outputAudioSize || 0)}</span></div><div class="output-actions"><button data-open-file="${escapeHtml(media.outputAudio)}">打开</button><button data-reveal-file="${escapeHtml(media.outputAudio)}">位置</button></div></div>`);
  }
  if (state.mediaResult?.media?.outputVideo) {
    const media = state.mediaResult.media;
    const profile = media.videoProfile;
    const detail = profile ? `${profile.width}×${profile.height} · ${formatSize(media.outputVideoSize || 0)}` : formatSize(media.outputVideoSize || 0);
    mediaItems.push(`<div class="output-item"><div><strong>成品视频.mp4</strong><span>${detail}</span></div><div class="output-actions"><button data-open-file="${escapeHtml(media.outputVideo)}">打开</button><button data-reveal-file="${escapeHtml(media.outputVideo)}">位置</button></div></div>`);
  }
  // 封面和文案 txt 也列出来。
  //
  // 这个面板原来只有音频和视频两项，而一次成品其实有四样东西 ——
  // 封面在盘上、文案 txt 在盘上，界面上却看不见，用户只能自己翻文件夹。
  const cover = state.mediaResult?.cover;
  for (const item of cover?.archived || []) {
    if (!item?.path) continue;
    mediaItems.push(outputRow(`封面 ${item.name}.png`, "叠字后的成品", item.path));
  }
  const copyTxt = state.mediaResult?.assets?.copyTxtPath;
  if (copyTxt) mediaItems.push(outputRow("七平台发布文案.txt", "标题 / 简介 / 标签，逐个平台", copyTxt));

  const items = mediaItems;
  $("outputCount").textContent = String(items.length);
  $("outputList").innerHTML = items.length ? items.join("") : `<div class="output-empty">暂无文件</div>`;
}

/** 产出列表的一行。打开 / 定位两个按钮的结构在多处重复，收成一个函数。 */
function outputRow(name, detail, filePath) {
  return `<div class="output-item">
    <div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(detail)}</span></div>
    <div class="output-actions">
      <button data-open-file="${escapeHtml(filePath)}">打开</button>
      <button data-reveal-file="${escapeHtml(filePath)}">位置</button>
    </div>
  </div>`;
}

/**
 * 磁盘上的历史成品。
 *
 * 上面那个列表只有**本次运行**的产出（读的是内存里的 state.mediaResult），
 * 服务一重启就空了，而盘上的东西一直在堆 —— 到今天 output/ 已经 100M 出头。
 * 这一块直接读盘，是为了让「哪些还占着地方」这件事在界面上看得见。
 */
async function loadOutputArchive() {
  const list = $("outputArchive");
  const total = $("outputArchiveTotal");
  state.archiveConfirming = "";
  list.innerHTML = `<div class="output-empty">读取中…</div>`;
  try {
    const data = await api("/api/output/runs");
    state.outputArchive = data.runs || [];
    total.textContent = `${state.outputArchive.length} 集 · 共 ${formatSize(data.totalBytes || 0)}`;
    list.innerHTML = state.outputArchive.length
      ? state.outputArchive.map(archiveRow).join("")
      : `<div class="output-empty">output 目录是空的</div>`;
  } catch (error) {
    total.textContent = "读取失败";
    list.innerHTML = `<div class="output-empty">${escapeHtml(error.message)}</div>`;
  }
}

/**
 * 一行历史成品。删除做成**行内两段式**，不用 window.confirm。
 *
 * 原来这里弹的是原生 confirm()，在内嵌 webview 里会被直接掐掉 ——
 * 控制台只留一句 "Page dialog suppressed…, confirm() returned false"，
 * 而对页面来说 confirm() 就是返回了 false，于是「点了删除毫无反应」。
 * 用户看到的是功能坏了，代码里却没有任何报错。
 * 行内确认不依赖宿主环境的任何能力，到哪都一样。
 */
function archiveRow(run) {
  const 媒体占比 = run.bytes ? Math.round((run.mediaBytes / run.bytes) * 100) : 0;
  const detail = `${run.date} · ${formatSize(run.bytes)} · ${run.files} 个文件 · 音视频占 ${媒体占比}%`;
  const rel = escapeHtml(run.relPath);
  const 待确认 = state.archiveConfirming === run.relPath;
  const actions = 待确认
    // 确认态要重复一遍后果：这一步之后就没有回收站了
    ? `<span class="archive-warn">整个目录删掉，不可恢复</span>
       <button data-archive-yes="${rel}" class="danger">确认删除</button>
       <button data-archive-no="${rel}">取消</button>`
    : `<button data-archive-ask="${rel}" class="danger">删除</button>`;
  return `<div class="output-item${待确认 ? " confirming" : ""}">
    <div><strong>${escapeHtml(run.title)}</strong><span>${escapeHtml(detail)}</span></div>
    <div class="output-actions">${actions}</div>
  </div>`;
}

/** 只切确认态并重画列表，不碰服务端。 */
function setArchiveConfirming(relPath) {
  state.archiveConfirming = relPath;
  const list = $("outputArchive");
  list.innerHTML = (state.outputArchive || []).length
    ? state.outputArchive.map(archiveRow).join("")
    : `<div class="output-empty">output 目录是空的</div>`;
}

/** 真的删。到这一步说明用户已经在行内点过「确认删除」。 */
async function deleteArchivedRun(relPath) {
  state.archiveConfirming = "";
  try {
    const result = await api("/api/output/runs", {
      method: "DELETE",
      body: JSON.stringify({ relPath })
    });
    toast(`已删除，腾出 ${formatSize(result.deletedBytes)}`);
    await loadOutputArchive();
  } catch (error) {
    toast(`删除失败：${error.message}`);
  }
}

function persistOutputs() {
  renderOutputs();
}

function showRun() {
  $("emptyState").hidden = true;
  $("runView").hidden = false;
  $("userMessage").textContent = `${$("brief").value.trim()} · 自然完成 · 自动查重并选择最优题目`;
  renderWorkflowProgress();
}

async function runFullWorkflow() {
  const engineMode = currentTextEngineMode();
  state.outputs = {};
  state.mediaResult = null;
  persistOutputs();
  state.selectedStep = "prepare";
  state.followCurrentStep = true;
  state.jobText = null;
  state.lastStageSignature = null;
  jobTextCache.clear();
  showRun();
  // 不再自动弹出 Agnes 半屏面板；需要看画面时在「生成并导出视频」那一步点开。
  const payload = await api("/api/workflow/jobs", {
    method: "POST",
    body: JSON.stringify({
      date: $("runDate").value,
      brief: $("brief").value.trim(),
      outputName: $("outputName").value.trim(),
      // 留空按默认 10 分钟；服务端也会兜一次底，不依赖前端。
      durationMinutes: Number($("runDuration").value) || DEFAULT_DURATION_MINUTES,
      textEngine: { mode: engineMode },
      providers: engineMode === "api" ? allProviders() : {}
    })
  });
  state.activeJob = payload.job;
  emitStudioEvent("sleepflow:workflow-updated", { job: payload.job });
  renderWorkflowProgress();
  await monitorJob(payload.job.id);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function notifyCompletion(job) {
  if (state.completionNotifiedJobId === job.id) return;
  state.completionNotifiedJobId = job.id;
  document.title = "✅ 已生成 · 眠屿";
  $("runNote").textContent = "生成完成，可以直接打开音频和视频，或在文件夹中查看全部内容。";
  setStudioTab("outputs");
  toast("音频与视频已生成，请检查平台草稿");
  if (job.runId) openDraftModal(job.runId).catch((error) => toast(error.message));
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("眠屿 · 生成完成", { body: `${job.result?.title || job.outputName || "本次任务"}的音频和视频已经准备好。` });
  }
}

async function monitorJob(jobId) {
  const token = ++state.pollToken;
  const button = $("runWorkflow");
  button.disabled = true;
  button.textContent = "正在生成";
  let transientFailures = 0;
  try {
    while (token === state.pollToken) {
      try {
        const payload = await api(`/api/workflow/jobs/${encodeURIComponent(jobId)}`);
        transientFailures = 0;
        const previousStep = state.activeJob?.currentStep;
        state.activeJob = payload.job;
        syncAgnesPanel(payload.job);
        emitStudioEvent("sleepflow:workflow-updated", { job: payload.job });
        if (state.followCurrentStep && payload.job.currentStep && payload.job.currentStep !== previousStep) {
          state.selectedStep = payload.job.currentStep;
        }
        if (payload.job.currentStep && state.followCurrentStep) state.selectedStep = payload.job.currentStep;
        // 文本产物是分步写盘的：每往前走一步就让缓存失效，展开时才能看到新内容。
        if (payload.job.currentStep !== previousStep) {
          jobTextCache.delete(payload.job.id);
          if (STEP_ARTIFACT[state.selectedStep]) {
            state.jobText = await loadJobText(payload.job.id);
          }
        }
        if (payload.job.result) {
          state.mediaResult = payload.job.result;
          if (payload.job.result.title) $("currentTask").textContent = payload.job.result.title;
          persistOutputs();
        }
        renderWorkflowProgress();
        if (payload.job.status === "completed") {
          notifyCompletion(payload.job);
          emitStudioEvent("sleepflow:workflow-completed", { job: payload.job });
          return payload.job;
        }
        if (payload.job.status === "failed") throw new Error(payload.job.error || "生成失败");
      } catch (error) {
        if (error.message !== "Failed to fetch" || ++transientFailures >= 5) throw error;
      }
      await wait(900);
    }
  } finally {
    if (token === state.pollToken) {
      button.disabled = false;
      button.textContent = "生成音频与视频";
    }
  }
}

async function openOutputFile(file, reveal) {
  try {
    await api("/api/files/open", { method: "POST", body: JSON.stringify({ path: file, reveal }) });
    toast(reveal ? "已在文件夹中显示" : "已打开文件");
  } catch (error) {
    toast(error.message);
  }
}

function blobDownload(filename, content) {
  const url = URL.createObjectURL(new Blob([`${content.trim()}\n`], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showResult(stageId) {
  const stage = STAGES.find((item) => item.id === stageId);
  $("resultTitle").textContent = stage.label;
  $("apiResultText").value = outputText(stageId);
  $("codexResultText").value = state.baseline[stageId] || "";
  openModal("resultModal");
}

function minimaxSettingsFromForm() {
  return {
    deliveryMode: document.querySelector('input[name="minimaxDeliveryMode"]:checked')?.value || "subscription",
    baseUrl: state.config.minimax.baseUrl,
    model: $("minimaxModel").value.trim(),
    voiceId: $("voiceId").value.trim(),
    speed: Number($("voiceSpeed").value),
    emotion: $("voiceEmotion").value.trim(),
    volume: Number($("voiceVolume").value),
    pitch: Number($("voicePitch").value),
    sampleRate: state.config.minimax.sampleRate,
    bitrate: state.config.minimax.bitrate,
    format: state.config.minimax.format,
    channel: state.config.minimax.channel,
    apiKeyEnv: state.config.minimax.apiKeyEnv,
    subscriptionApiKeyEnv: state.config.minimax.subscriptionApiKeyEnv || "MINIMAX_SUBSCRIPTION_KEY"
  };
}

function renderMinimaxDeliveryMode(modeOverride) {
  const mode = modeOverride === "api" ? "api" : "subscription";
  const radio = document.querySelector(`input[name="minimaxDeliveryMode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  const subscription = mode === "subscription";
  $("minimaxKeyLabel").textContent = subscription ? "MiniMax 订阅 Key" : "MiniMax 普通 API Key";
  $("minimaxApiKey").placeholder = subscription ? "保存订阅 Key 到 macOS 钥匙串" : "保存普通 API Key 到 macOS 钥匙串";
  $("testMinimax").textContent = subscription ? "测试订阅 Key 与试听" : "测试普通 API 与试听";
}

function fillMinimax() {
  const settings = state.config.minimax;
  $("minimaxModel").value = settings.model;
  $("voiceId").value = settings.voiceId;
  $("voiceSpeed").value = settings.speed;
  $("voiceEmotion").value = settings.emotion;
  $("voiceVolume").value = settings.volume;
  $("voicePitch").value = settings.pitch;
  $("minimaxApiKeyEnv").value = settings.apiKeyEnv;
  renderMinimaxDeliveryMode(settings.deliveryMode);
}

function fillVideoSettings() {
  const quality = state.config?.media?.videoQuality || "balanced";
  const radio = document.querySelector(`input[name="videoQuality"][value="${quality}"]`);
  if (radio) radio.checked = true;
}

/**
 * 文本引擎 API Key 的状态 / 保存 / 删除。
 *
 * 2026-08-14 补上。在此之前这一块**根本没有界面**：
 * 后端的 /api/text/key（写 macOS 钥匙串）一直在，但前端从没调过它；
 * 而每个步骤那行里的「API Key」输入框是假的 —— renderProviderSettings 里
 * 明确跳过它不自动保存，persistProvider 又 `delete provider.apiKey`，
 * 于是你输进去的 key 走不到任何地方，刷新就没。
 * 占位符还写着「已安全保存，可留空」，实际上什么都没保存。
 * 用户的说法是「每次都得重新保存」，其实是**一次都没保存成功过**。
 */
async function loadTextKeyStatus() {
  const node = $("textKeyStatus");
  try {
    const status = await api("/api/text/key-status");
    node.textContent = status.configured
      ? (status.source === "environment" ? "已通过环境变量配置" : "已保存到 macOS 钥匙串")
      : "尚未保存";
  } catch (error) {
    node.textContent = `读取失败：${error.message}`;
  }
}

async function loadMinimaxStatus() {
  const mode = document.querySelector('input[name="minimaxDeliveryMode"]:checked')?.value || state.config?.minimax?.deliveryMode || "subscription";
  const status = await api(`/api/minimax/key-status?mode=${encodeURIComponent(mode)}`);
  $("minimaxKeyStatus").textContent = status.configured
    ? (status.source === "environment" ? `已通过环境变量配置${mode === "subscription" ? "订阅 Key" : "普通 API Key"}` : `已保存${mode === "subscription" ? "订阅 Key" : "普通 API Key"}到 macOS 钥匙串`)
    : `尚未保存${mode === "subscription" ? "订阅 Key" : "普通 API Key"}`;
}

async function assertFullWorkflowReady() {
  if (!state.config) throw new Error("正在加载设置，请稍候");
  const missing = [];
  const mode = state.config.minimax.deliveryMode === "api" ? "api" : "subscription";
  const keyStatus = await api(`/api/minimax/key-status?mode=${encodeURIComponent(mode)}`);
  if (!keyStatus.configured) missing.push(mode === "subscription" ? "MiniMax 订阅 Key" : "MiniMax 普通 API Key");
  if (!state.config.minimax.voiceId) missing.push("voice_id");
  if (!state.config.media.bgmRoot) missing.push("背景音乐目录");
  if (!state.config.media.videoRoot) missing.push("视频素材目录");
  if (missing.length) throw new Error(`请先完成：${missing.join("、")}`);
}

async function testProvider(stageId) {
  const node = $(`provider-state-${stageId}`);
  node.textContent = "测试中…";
  node.className = "api-test-state";
  try {
    const result = await api("/api/compare/test", {
      method: "POST",
      body: JSON.stringify({ provider: providerFromRow(stageId) })
    });
    node.textContent = `连接成功 · ${result.latencyMs} ms`;
    node.className = "api-test-state good";
  } catch (error) {
    node.textContent = error.message;
    node.className = "api-test-state error";
  }
}

function copyFirstProvider() {
  const source = providerFromRow("topic");
  for (const stage of STAGES.slice(1)) {
    const row = document.querySelector(`[data-provider="${stage.id}"]`);
    for (const [key, value] of Object.entries(source)) {
      const field = row.querySelector(`[data-field="${key}"]`);
      if (field) field.value = value;
    }
    persistProvider(stage.id);
  }
  toast("已复制到全部步骤");
}

async function saveTextEngineSettings({ silent = false } = {}) {
  const payload = await api("/api/config", {
    method: "PUT",
    body: JSON.stringify({
      textEngine: {
        mode: currentTextEngineMode(),
        codexCli: codexSettingsFromForm()
      }
    })
  });
  state.config = payload.config;
  renderTextEngineMode();
  if (!silent) toast("文本引擎已保存");
  return payload.config;
}

async function detectCodexCli() {
  const button = $("detectCodexCli");
  button.disabled = true;
  $("codexCliLog").textContent = "正在自动寻找 Codex CLI 并检查登录状态…";
  try {
    await saveTextEngineSettings({ silent: true });
    const status = await api("/api/codex/status");
    showCodexStatus(status);
    $("codexCliLog").textContent = JSON.stringify({
      connected: status.connected,
      path: status.path,
      version: status.version,
      authStatus: status.authStatus,
      model: state.config.textEngine.codexCli.model
    }, null, 2);
    toast(status.connected ? "Codex CLI 已连接" : "Codex CLI 尚未连接");
  } catch (error) {
    $("codexCliLog").textContent = error.message;
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function testCodexCli() {
  const button = $("testCodexCli");
  button.disabled = true;
  $("codexCliLog").textContent = "正在通过 Codex CLI 运行最小生成测试…";
  try {
    const result = await api("/api/codex/test", {
      method: "POST",
      body: JSON.stringify({ settings: codexSettingsFromForm() })
    });
    $("codexCliLog").textContent = JSON.stringify(result, null, 2);
    showCodexStatus({
      ...(state.codexStatus || {}),
      available: true,
      connected: true,
      path: result.path,
      version: result.version,
      authStatus: "生成测试成功"
    });
    toast("Codex CLI 生成测试成功");
  } catch (error) {
    $("codexCliLog").textContent = error.message;
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function refreshAll() {
  const [status, baseline] = await Promise.all([
    api("/api/status"),
    api("/api/compare/baseline")
  ]);
  state.config = status.config;
  state.skills = status.skills;
  state.runtime = status.runtime;
  state.paths = status.paths;
  state.baseline = baseline.outputs;
  $("serviceDot").classList.add("ready");
  const agnes = status.runtime.agnes || {};
  $("agnesTopDot").classList.toggle("ready", Boolean(agnes.connected));
  $("agnesStatusText").textContent = agnes.connected
    ? "已连接 · 与眠屿共享当前任务"
    : (agnes.enabled ? "暂未连接，启动任务时会自动重试" : "尚未启用");
  loadAgnesPanel();
  const codex = status.runtime.codex;
  $("serviceText").textContent = state.config.textEngine.mode === "codex-cli"
    ? `${codex.connected ? "Codex 已连接" : "Codex 未连接"} · ${state.skills.length} 个 Skill`
    : `API 模式 · ${state.skills.length} 个 Skill`;
  $("bgmRoot").value = state.config.media.bgmRoot;
  $("videoRoot").value = state.config.media.videoRoot;
  renderRoots();
  renderSlots();
  renderSkills();
  renderProviderSettings();
  fillCodexSettings();
  showDraftPublisherStatus(status.runtime.publisher || {});
  fillMinimax();
  fillVideoSettings();
  const [, , , , topicHistory] = await Promise.all([
    loadMinimaxStatus(),
    loadTextKeyStatus(),
    loadMediaLibrary("bgm"),
    loadMediaLibrary("video"),
    api("/api/topic-history")
  ]);
  $("topicHistoryCount").textContent = `已收录 ${topicHistory.count} 个`;
  if (!state.activeJob) {
    const latest = await api("/api/workflow/jobs/latest").catch(() => ({ job: null }));
    if (latest.job) {
      state.activeJob = latest.job;
      state.selectedStep = latest.job.currentStep || "prepare";
      state.mediaResult = latest.job.result || null;
      syncAgnesPanel(latest.job);
      $("currentTask").textContent = latest.job.result?.title || latest.job.outputName || `${latest.job.brief || "晚上"} · 自动选题`;
      showRun();
      if (latest.job.status === "running" || latest.job.status === "queued") monitorJob(latest.job.id).catch((error) => toast(error.message));
      if (latest.job.status === "completed") notifyCompletion(latest.job);
    }
  }
  renderOutputs();
  renderWorkflowProgress();
  $("runWorkflow").disabled = Boolean(state.activeJob && ["queued", "running"].includes(state.activeJob.status));
}

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => $(button.dataset.close).close());
});
$("openLibrary").addEventListener("click", () => openModal("libraryModal"));
$("openApiSettings").addEventListener("click", () => openModal("apiModal"));
$("openPublishing").addEventListener("click", () => openDraftModal().catch((error) => toast(error.message)));

document.querySelectorAll("[data-library-tab]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-library-tab],#libraryModal .modal-panel").forEach((node) => node.classList.remove("active"));
  button.classList.add("active");
  $(`library-${button.dataset.libraryTab}`).classList.add("active");
}));
document.querySelectorAll("[data-api-tab]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-api-tab],#apiModal .modal-panel").forEach((node) => node.classList.remove("active"));
  button.classList.add("active");
  $(`api-${button.dataset.apiTab}`).classList.add("active");
}));

document.querySelectorAll('input[name="textEngineMode"]').forEach((radio) => {
  radio.addEventListener("change", () => renderTextEngineMode(radio.value));
});
document.querySelectorAll('input[name="minimaxDeliveryMode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    renderMinimaxDeliveryMode(radio.value);
    loadMinimaxStatus().catch((error) => toast(error.message));
  });
});
$("detectCodexCli").addEventListener("click", detectCodexCli);
$("testCodexCli").addEventListener("click", testCodexCli);
$("refreshDraftStatus").addEventListener("click", () => refreshDraftStatus().catch((error) => toast(error.message)));
$("draftSelectAll").addEventListener("change", (event) => {
  document.querySelectorAll(".draft-platform-check").forEach((check) => { check.checked = event.target.checked; });
  syncDraftSelection();
});
$("draftPlatformList").addEventListener("change", (event) => {
  if (event.target.matches(".draft-platform-check")) syncDraftSelection();
});
$("draftPlatformList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-draft-login]");
  if (button) openDraftLogin(button.dataset.draftLogin).catch((error) => toast(error.message));
});
$("savePlatformDrafts").addEventListener("click", () => savePlatformDrafts().catch((error) => {
  syncDraftSelection();
  toast(error.message);
}));
$("closeDraftLogin").addEventListener("click", () => {
  $("draftLoginPanel").hidden = true;
  if (state.draftLoginSource) state.draftLoginSource.close();
  state.draftLoginSource = null;
});
$("refreshAfterLogin").addEventListener("click", () => {
  refreshDraftStatus().then(() => {
    if (state.draftHandoff) renderDraftPlatforms();
    toast("登录状态已刷新");
  }).catch((error) => toast(error.message));
});
$("saveTextEngine").addEventListener("click", async () => {
  try {
    await saveTextEngineSettings();
    await refreshAll();
  } catch (error) {
    toast(error.message);
  }
});

$("providerSettings").addEventListener("click", (event) => {
  const stageId = event.target.dataset.testProvider;
  if (stageId) testProvider(stageId);
});
$("copyFirstProvider").addEventListener("click", copyFirstProvider);

$("addSkillRoot").addEventListener("click", async () => {
  const root = $("skillRootInput").value.trim();
  if (!root) return;
  await api("/api/config", {
    method: "PUT",
    body: JSON.stringify({ skillRoots: [...new Set([...state.config.skillRoots, root])] })
  });
  $("skillRootInput").value = "";
  await refreshAll();
});
$("rootList").addEventListener("click", async (event) => {
  if (event.target.dataset.removeRoot === undefined) return;
  const roots = [...state.config.skillRoots];
  roots.splice(Number(event.target.dataset.removeRoot), 1);
  await api("/api/config", { method: "PUT", body: JSON.stringify({ skillRoots: roots }) });
  await refreshAll();
});
$("refreshSkills").addEventListener("click", refreshAll);
$("saveSlots").addEventListener("click", async () => {
  const payload = await api("/api/config", { method: "PUT", body: JSON.stringify({ slots: state.draftSlots }) });
  state.config = payload.config;
  renderProviderSettings();
  toast("技能绑定已保存");
});

document.querySelectorAll("[data-choose-media]").forEach((button) => {
  button.addEventListener("click", () => chooseMediaRoot(button));
});
document.querySelectorAll("[data-save-media]").forEach((button) => button.addEventListener("click", async () => {
  const type = button.dataset.saveMedia;
  const key = type === "bgm" ? "bgmRoot" : "videoRoot";
  try {
    await saveMediaRoot(type, $(key).value.trim());
    toast("素材库路径已保存");
  } catch (error) {
    toast(error.message);
  }
}));

$("toggleMinimaxKey").addEventListener("click", () => {
  const input = $("minimaxApiKey");
  input.type = input.type === "password" ? "text" : "password";
  $("toggleMinimaxKey").textContent = input.type === "password" ? "显示" : "隐藏";
});
$("toggleTextKey").addEventListener("click", () => {
  const input = $("textApiKey");
  const 隐藏中 = input.type === "password";
  input.type = 隐藏中 ? "text" : "password";
  $("toggleTextKey").textContent = 隐藏中 ? "隐藏" : "显示";
});
$("saveTextKey").addEventListener("click", async () => {
  const key = $("textApiKey").value.trim();
  if (!key) return toast("请粘贴 API Key");
  try {
    await api("/api/text/key", { method: "PUT", body: JSON.stringify({ apiKey: key }) });
    // 存完就把输入框清空并遮回去：让明文 key 一直躺在页面上没有任何好处
    $("textApiKey").value = "";
    $("textApiKey").type = "password";
    $("toggleTextKey").textContent = "显示";
    await loadTextKeyStatus();
    toast("文本引擎 Key 已保存到钥匙串");
  } catch (error) {
    toast(`保存失败：${error.message}`);
  }
});
$("deleteTextKey").addEventListener("click", async () => {
  try {
    await api("/api/text/key", { method: "DELETE" });
    await loadTextKeyStatus();
    toast("已删除");
  } catch (error) {
    toast(`删除失败：${error.message}`);
  }
});

$("saveMinimaxKey").addEventListener("click", async () => {
  const key = $("minimaxApiKey").value.trim();
  if (!key) return toast("请粘贴 API Key");
  // 兜底必须跟着 config.minimax.deliveryMode 走，不能硬编码 "subscription"。
  // 页面刚载入、用户还没点过单选框时 :checked 是 null；原来这里直接退回
  // "subscription"，于是 key 被存进订阅槽，而合成读的是 deliveryMode 指定的
  // api 槽 —— 存了等于没存，界面还一直显示「尚未保存」。
  const mode = document.querySelector('input[name="minimaxDeliveryMode"]:checked')?.value
    || state.config?.minimax?.deliveryMode
    || "subscription";
  await api("/api/minimax/key", { method: "PUT", body: JSON.stringify({ apiKey: key, mode }) });
  $("minimaxApiKey").value = "";
  $("minimaxApiKey").type = "password";
  $("toggleMinimaxKey").textContent = "显示";
  await loadMinimaxStatus();
  toast(mode === "subscription" ? "订阅 Key 已保存" : "普通 API Key 已保存");
});
$("deleteMinimaxKey").addEventListener("click", async () => {
  // 兜底必须跟着 config.minimax.deliveryMode 走，不能硬编码 "subscription"。
  // 页面刚载入、用户还没点过单选框时 :checked 是 null；原来这里直接退回
  // "subscription"，于是 key 被存进订阅槽，而合成读的是 deliveryMode 指定的
  // api 槽 —— 存了等于没存，界面还一直显示「尚未保存」。
  const mode = document.querySelector('input[name="minimaxDeliveryMode"]:checked')?.value
    || state.config?.minimax?.deliveryMode
    || "subscription";
  if (!window.confirm(`确定删除 MiniMax ${mode === "subscription" ? "订阅 Key" : "普通 API Key"}吗？`)) return;
  await api("/api/minimax/key", { method: "DELETE", body: JSON.stringify({ mode }) });
  await loadMinimaxStatus();
});
$("saveMinimaxSettings").addEventListener("click", async () => {
  const payload = await api("/api/config", {
    method: "PUT",
    body: JSON.stringify({ minimax: minimaxSettingsFromForm() })
  });
  state.config = payload.config;
  toast("声音参数已保存");
});
$("testMinimax").addEventListener("click", async () => {
  const button = $("testMinimax");
  button.disabled = true;
  $("minimaxDebug").textContent = "测试中…";
  try {
    const settings = minimaxSettingsFromForm();
    const saved = await api("/api/config", { method: "PUT", body: JSON.stringify({ minimax: settings }) });
    state.config = saved.config;
    const payload = await api("/api/minimax/test", {
      method: "POST",
      body: JSON.stringify({ settings, text: $("minimaxTestText").value.trim() })
    });
    const bytes = Uint8Array.from(atob(payload.audioBase64), (char) => char.charCodeAt(0));
    if (state.minimaxAudioUrl) URL.revokeObjectURL(state.minimaxAudioUrl);
    state.minimaxAudioUrl = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType }));
    $("minimaxTestAudio").src = state.minimaxAudioUrl;
    $("minimaxTestAudio").hidden = false;
    $("minimaxDebug").textContent = JSON.stringify({ ok: true, info: payload.info, debug: payload.debug }, null, 2);
    toast("MiniMax 测试成功");
  } catch (error) {
    $("minimaxDebug").textContent = JSON.stringify({ ok: false, error: error.message, debug: error.payload?.debug || null }, null, 2);
    document.querySelector(".debug-panel").open = true;
  } finally {
    button.disabled = false;
  }
});

$("saveVideoSettings").addEventListener("click", async () => {
  const videoQuality = document.querySelector('input[name="videoQuality"]:checked')?.value || "balanced";
  try {
    const payload = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ media: { videoQuality } })
    });
    state.config = payload.config;
    toast("视频导出设置已保存");
  } catch (error) {
    toast(error.message);
  }
});

$("resumableRuns").addEventListener("click", async (event) => {
  const discard = event.target.closest("[data-discard-run]");
  if (discard) {
    const runId = discard.dataset.discardRun;
    const row = discard.closest(".resumable-row");
    const title = row?.querySelector("strong")?.textContent || runId;
    // 说清楚「丢弃」到底做什么：只从列表移除，不删磁盘上的文稿和人声。
    // 那份人声烧过 MiniMax 额度，不该让人以为点一下就没了。
    if (!confirm(`把「${title}」从待续列表里移除？\n\n磁盘上的文稿和人声会保留，只是不再出现在这里。`)) return;
    discard.disabled = true;
    discard.textContent = "…";
    try {
      await api(`/api/workflow/runs/${encodeURIComponent(runId)}/discard`, { method: "DELETE" });
      state.resumableRuns = (state.resumableRuns || []).filter((item) => item.runId !== runId);
      renderResumableRuns();
      toast("已从列表移除");
    } catch (error) {
      discard.disabled = false;
      discard.textContent = "丢弃";
      toast(`丢弃失败：${error.message}`);
    }
    return;
  }
  const button = event.target.closest("[data-resume-run]");
  if (!button) return;
  const runId = button.dataset.resumeRun;
  button.disabled = true;
  button.textContent = "正在续跑…";
  try {
    const payload = await api(`/api/workflow/runs/${encodeURIComponent(runId)}/resume`, { method: "POST" });
    state.activeJob = payload.job;
    state.resumableRuns = null;
    state.lastStageSignature = null;
    state.followCurrentStep = true;
    $("resumableRuns").hidden = true;
    renderWorkflowProgress();
    await monitorJob(payload.job.id);
  } catch (error) {
    button.disabled = false;
    button.textContent = "继续";
    alert(`续跑失败：${error.message}`);
  }
});

/**
 * 重跑某一步。
 *
 * 会连带重做下游的档位（RERUN_HINT.affects 非空）先弹确认 —— 那些档会覆盖
 * 已经生成好的音频或视频，而且要重新等十几到四十分钟。
 */
async function startRerun(button, stepId) {
  const job = state.activeJob;
  const hint = RERUN_HINT[stepId];
  if (!job?.runId || !hint) return;

  const needsConfirm = hint.affects.length || hint.danger;
  if (needsConfirm) {
    const lines = [
      `确定要「${hint.label}」吗？`,
      hint.affects.length ? `会连带重做：${hint.affects.join(" → ")}（已生成的会被覆盖）` : "",
      hint.cost
    ].filter(Boolean);
    if (!confirm(lines.join("\n"))) return;
  }

  const original = button.textContent;
  button.disabled = true;
  button.textContent = "正在启动…";
  try {
    const payload = await api(`/api/workflow/runs/${encodeURIComponent(job.runId)}/rerun`, {
      method: "POST",
      body: JSON.stringify({ from: stepId })
    });
    state.activeJob = payload.job;
    // 换了新任务，这些缓存全部作废
    state.resumeCheck = null;
    state.jobText = null;
    state.completionNotifiedJobId = null;
    state.followCurrentStep = true;
    state.selectedStep = stepId;
    renderWorkflowProgress();
    toast(`已开始${hint.label}`);
    await monitorJob(payload.job.id);
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    alert(`重跑失败：${error.message}`);
  }
}

$("resumeBar").addEventListener("click", async (event) => {
  if (!event.target.closest("#doResume")) return;
  const job = state.activeJob;
  if (!job) return;
  const button = event.target.closest("#doResume");
  button.disabled = true;
  button.textContent = "正在续跑…";
  try {
    const payload = await api(`/api/workflow/jobs/${encodeURIComponent(job.id)}/resume`, { method: "POST" });
    state.activeJob = payload.job;
    state.resumeCheck = null;
    state.followCurrentStep = true;
    renderWorkflowProgress();
    await monitorJob(payload.job.id);
  } catch (error) {
    button.disabled = false;
    button.textContent = "继续";
    alert(`续跑失败：${error.message}`);
  }
});

$("stageList").addEventListener("click", async (event) => {
  const head = event.target.closest("[data-select-step]");
  if (head) {
    const id = head.dataset.selectStep;
    // 再点一次已展开的步骤 = 收起
    state.selectedStep = state.selectedStep === id ? null : id;
    state.followCurrentStep = false;
    // 展开文本类步骤时按需拉取产物；Agnes 不再自动弹出，改成面板里手动点
    if (state.selectedStep && STEP_ARTIFACT[state.selectedStep] && !state.jobText) {
      state.jobText = await loadJobText(state.activeJob?.id);
    }
    renderWorkflowProgress();
    return;
  }
  if (event.target.closest("#stageOpenAgnes")) {
    showVisualStudio("agnes");
    return;
  }
  if (event.target.closest("#stageOpenPublishStatus")) {
    openDraftModal().catch((error) => toast(error.message));
    return;
  }
  const rerunBtn = event.target.closest("[data-rerun-step]");
  if (rerunBtn) {
    await startRerun(rerunBtn, rerunBtn.dataset.rerunStep);
    return;
  }
  const copyBtn = event.target.closest("[data-copy-artifact]");
  if (copyBtn) {
    const value = asText(state.jobText?.[copyBtn.dataset.copyArtifact]);
    navigator.clipboard?.writeText(value);
    copyBtn.textContent = "已复制";
    setTimeout(() => { copyBtn.textContent = "复制"; }, 1500);
    return;
  }
  const openButton = event.target.closest("[data-open-file]");
  const revealButton = event.target.closest("[data-reveal-file]");
  if (openButton) openOutputFile(openButton.dataset.openFile, false);
  if (revealButton) openOutputFile(revealButton.dataset.revealFile, true);
});

$("outputArchive").addEventListener("click", (event) => {
  const ask = event.target.closest("[data-archive-ask]");
  const yes = event.target.closest("[data-archive-yes]");
  const no = event.target.closest("[data-archive-no]");
  if (ask) setArchiveConfirming(ask.dataset.archiveAsk);
  if (no) setArchiveConfirming("");
  if (yes) deleteArchivedRun(yes.dataset.archiveYes);
});
$("reloadOutputArchive").addEventListener("click", loadOutputArchive);

$("outputList").addEventListener("click", (event) => {
  const openButton = event.target.closest("[data-open-file]");
  const revealButton = event.target.closest("[data-reveal-file]");
  if (openButton) openOutputFile(openButton.dataset.openFile, false);
  if (revealButton) openOutputFile(revealButton.dataset.revealFile, true);
});

document.querySelectorAll("[data-studio-tab]").forEach((button) => {
  button.addEventListener("click", () => setStudioTab(button.dataset.studioTab));
});
$("openVisualStudio").addEventListener("click", () => showVisualStudio("agnes"));
$("closeVisualStudio").addEventListener("click", closeVisualStudio);
$("reloadAgnes").addEventListener("click", () => loadAgnesPanel(state.activeJob?.agnesJobId || "", true));
$("showIntegrationInfo").addEventListener("click", () => {
  toast("二次开发接口已开放：/api/integrations 和 window.SleepflowStudio");
});
$("agnesFrame").addEventListener("load", () => {
  $("agnesFrameState").hidden = true;
});
window.addEventListener("message", (event) => {
  const expectedOrigin = state.runtime?.agnes?.baseUrl ? new URL(state.runtime.agnes.baseUrl).origin : "";
  if (!expectedOrigin || event.origin !== expectedOrigin || event.data?.source !== "agnes-ai") return;
  const type = String(event.data.type || "");
  const payload = event.data.payload || {};
  if (type === "ready") {
    $("agnesTopDot").classList.add("ready");
    $("agnesStatusText").textContent = "已连接 · 与眠屿共享当前任务";
  } else if (type === "progress") {
    $("agnesStatusText").textContent = payload.message || "正在生成视觉内容";
  } else if (type === "completed") {
    $("agnesStatusText").textContent = "视觉成品已完成，正在交回眠屿";
  } else if (type === "failed") {
    $("agnesStatusText").textContent = payload.error || "视觉生成未完成";
  }
  emitStudioEvent(`agnes:${type}`, payload);
});

function setPeriod(period) {
  const next = period === "中午" ? "中午" : "晚上";
  $("brief").value = next;
  document.querySelectorAll("[data-period]").forEach((button) => {
    const selected = button.dataset.period === next;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  if (!state.activeJob) $("currentTask").textContent = `${next} · 自动选题`;
}

document.querySelectorAll("[data-period]").forEach((button) => {
  button.addEventListener("click", () => setPeriod(button.dataset.period));
});

$("runWorkflow").addEventListener("click", async () => {
  const brief = $("brief").value.trim();
  if (!brief) return toast("请输入创作方向");
  const button = $("runWorkflow");
  try {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    await assertFullWorkflowReady();
    button.disabled = true;
    button.textContent = "生成中";
    $("currentTask").textContent = $("outputName").value.trim() || `${brief} · 自动选题`;
    await runFullWorkflow();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "生成音频与视频";
  }
});

function startNewTask() {
  if (state.activeJob && ["queued", "running"].includes(state.activeJob.status)) return toast("当前任务还在生成，可以在左侧查看进度");
  state.pollToken += 1;
  state.outputs = {};
  state.stepStatus = {};
  state.mediaResult = null;
  state.activeJob = null;
  state.selectedStep = "prepare";
  state.followCurrentStep = true;
  setPeriod("晚上");
  $("outputName").value = "";
  $("currentTask").textContent = "晚上 · 自动选题";
  $("runView").hidden = true;
  $("emptyState").hidden = false;
  $("runNote").textContent = "";
  document.title = "眠屿";
  loadAgnesPanel();
  renderOutputs();
  renderWorkflowProgress();
}

$("cancelJob").addEventListener("click", async () => {
  const job = state.activeJob;
  if (!job) return;
  const running = (job.steps || []).find((step) => step.status === "running");
  const warning = running
    ? `正在「${running.label}」。取消会中断它，这一步的产出会丢失。`
    : "取消后这次生成就停在这里了。";
  if (!confirm(`${warning}\n\n已经跑完的步骤和落盘的文件会保留，之后可以从中断处继续。确定取消？`)) return;
  const button = $("cancelJob");
  button.disabled = true;
  button.textContent = "取消中";
  try {
    const resp = await fetch(`/api/workflow/jobs/${encodeURIComponent(job.id)}/cancel`, { method: "POST" });
    const payload = await resp.json();
    if (!resp.ok) throw new Error(payload.error || "取消失败");
    state.activeJob = payload.job;
    state.lastStageSignature = null;
    renderWorkflowProgress();
    toast("已取消");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "取消";
  }
});

$("newTask").addEventListener("click", startNewTask);
// 摘要条上的「新任务」和侧栏那个是同一件事，走同一个函数，别抄一份重置逻辑。
$("composerNewTask").addEventListener("click", startNewTask);

$("runDate").value = new Date().toLocaleDateString("en-CA");
refreshAll().catch((error) => {
  $("serviceText").textContent = error.message;
  toast(error.message);
});
