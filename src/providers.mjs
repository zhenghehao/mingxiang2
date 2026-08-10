import { readMinimaxKey, readTextProviderKey } from "./secrets.mjs";
import { callCodexCliText } from "./codex-cli.mjs";

export async function callTextProvider(config, instructions, input) {
  const provider = config.textProvider;
  if (!provider.model) throw new Error("请先填写文本模型名称");
  const environmentKey = process.env[provider.apiKeyEnv];
  const keychainKey = environmentKey ? "" : await readTextProviderKey();
  const apiKey = environmentKey || keychainKey;
  if (!apiKey) throw new Error(`尚未配置文本 API Key（环境变量 ${provider.apiKeyEnv} 或 macOS 钥匙串）`);

  const response = await fetch(provider.baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: Number(provider.temperature ?? 0.7),
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: input }
      ]
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `文本 API 请求失败：${response.status}`);
  const text = payload?.choices?.[0]?.message?.content;
  if (!text) throw new Error("文本 API 没有返回内容");
  return text;
}

function getByPath(value, dottedPath) {
  return String(dottedPath || "")
    .match(/[^.[\]]+/g)
    ?.reduce((current, key) => current?.[key], value);
}

function normalizeTextContent(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      return item?.text || item?.content || "";
    }).filter(Boolean).join("\n").trim();
  }
  return "";
}

export async function callCustomTextProvider(provider, instructions, input, options = {}) {
  const endpoint = String(provider?.endpoint || "").trim();
  const model = String(provider?.model || "").trim();
  if (!endpoint) throw new Error("请填写接口地址");
  if (!model) throw new Error("请填写模型名称");
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("接口地址格式不正确，请填写完整的 http 或 https 地址");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("接口地址只支持 http 或 https");

  const headers = { "Content-Type": "application/json" };
  const apiKey = String(provider?.apiKey || options.defaultApiKey || "").trim();
  if (apiKey) {
    // HTTP 头只接受 Latin1（0-255）字符。如果 API Key 里混入了中文、全角符号或
    // 复制粘贴带进来的隐藏字符，fetch 会抛出难懂的 ByteString 错误，这里提前拦截并给出清晰提示。
    const illegal = apiKey.match(/[^\u0000-\u00ff]/);
    if (illegal) {
      throw new Error(`API Key 含有非法字符“${illegal[0]}”（中文或全角字符），请删除后重新粘贴纯英文数字的密钥`);
    }
    const headerName = String(provider?.authHeader || "Authorization").trim() || "Authorization";
    const prefix = provider?.authPrefix === undefined ? "Bearer " : String(provider.authPrefix);
    headers[headerName] = `${prefix}${apiKey}`;
  }
  const requestBody = {
    model,
    temperature: Number(provider?.temperature ?? 0.7),
    stream: false,
    messages: [
      { role: "system", content: instructions },
      { role: "user", content: input }
    ]
  };
  if (options.maxTokens) requestBody.max_tokens = Number(options.maxTokens);
  if (options.disableThinking) requestBody.thinking = { type: "disabled" };

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      // 冥想文稿动辄上千字，整篇改写比一般对话慢得多。
      // 原来 180s 太紧：2026-07-25 实测「收紧篇幅」这一步正好卡在 180s 超时，
      // 把整轮生成带走了。
      signal: AbortSignal.timeout(Number(options.timeoutMs || 420_000))
    });
  } catch (error) {
    if (error?.name === "TimeoutError") throw new Error("接口请求超时，请检查地址、网络或模型状态");
    throw new Error(`无法连接接口：${error.message}`);
  }
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    if (!response.ok) throw new Error(`接口请求失败：${response.status} ${raw.slice(0, 300)}`);
    throw new Error("接口返回的不是 JSON，请确认它兼容 Chat Completions 格式");
  }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || payload?.msg || raw.slice(0, 300);
    throw new Error(`接口请求失败（${response.status}）：${message}`);
  }

  const configured = provider?.responsePath ? getByPath(payload, provider.responsePath) : undefined;
  const candidate = configured
    ?? payload?.choices?.[0]?.message?.content
    ?? payload?.output_text
    ?? payload?.data?.output_text
    ?? payload?.result
    ?? payload?.content;
  const text = normalizeTextContent(candidate);
  if (!text) {
    // 「没取到文本」有两种成因，重试价值完全相反，必须分开报：
    //   1. 信封认得出（choices[0].message 在），只是内容是空的 —— 模型这一次
    //      没吐东西，属于瞬时故障，重发大概率就好（2026-08-10 实测：六次相同
    //      调用只有一次这样）。
    //   2. 整个响应结构不认识 —— 地址或 responsePath 配错了，重发一万次还是错。
    // 以前两种共用一句话，上层的重试判据没法区分，只能一律不重试。
    const 信封正常 = payload?.choices?.[0]?.message !== undefined;
    throw new Error(信封正常
      ? "接口返回了空内容（choices 在但 content 为空），可能是模型这次没有输出"
      : "接口已响应，但没有找到文本内容；可在高级设置中填写响应路径");
  }
  return text;
}

export async function callTextEngine(config, provider, instructions, input, options = {}) {
  const mode = String(options.mode || config?.textEngine?.mode || "api");
  if (mode === "codex-cli") {
    return callCodexCliText(config, instructions, input, options);
  }
  const started = Date.now();
  const environmentKey = process.env[config?.textProvider?.apiKeyEnv || "TEXT_API_KEY"];
  const keychainKey = environmentKey || provider?.apiKey ? "" : await readTextProviderKey();
  const text = provider
    ? await callCustomTextProvider(provider, instructions, input, {
      ...options,
      defaultApiKey: environmentKey || keychainKey
    })
    : await callTextProvider(config, instructions, input);
  return {
    text,
    engine: "api",
    model: provider?.model || config?.textProvider?.model || "",
    reasoningEffort: "",
    elapsedMs: Date.now() - started,
    path: "",
    version: ""
  };
}

function minimaxError(message, debug) {
  const error = new Error(message);
  error.debug = debug;
  return error;
}

export async function synthesizeMinimax(config, text) {
  const settings = config.minimax;
  const deliveryMode = settings.deliveryMode === "subscription" ? "subscription" : "api";
  const environmentName = deliveryMode === "subscription"
    ? (settings.subscriptionApiKeyEnv || "MINIMAX_SUBSCRIPTION_KEY")
    : settings.apiKeyEnv;
  const environmentKey = process.env[environmentName];
  const keychainKey = environmentKey ? "" : await readMinimaxKey(deliveryMode);
  const apiKey = environmentKey || keychainKey;
  const modeLabel = deliveryMode === "subscription" ? "订阅 Key" : "普通 API Key";
  const keySource = environmentKey ? `环境变量 ${environmentName}` : (keychainKey ? `macOS 钥匙串 · ${modeLabel}` : "未配置");
  if (!apiKey) throw minimaxError(`尚未配置 MiniMax ${modeLabel}，请先保存到 macOS 钥匙串`, { keySource, deliveryMode });
  if (!settings.voiceId) throw new Error("请先填写 MiniMax voice_id");

  const requestBody = {
    model: settings.model,
    text,
    stream: false,
    voice_setting: {
      voice_id: settings.voiceId,
      speed: Number(settings.speed),
      vol: Number(settings.volume),
      pitch: Number(settings.pitch),
      emotion: settings.emotion || "calm"
    },
    audio_setting: {
      sample_rate: Number(settings.sampleRate),
      bitrate: Number(settings.bitrate),
      format: settings.format,
      channel: Number(settings.channel)
    },
    language_boost: "Chinese",
    subtitle_enable: false,
    output_format: "hex"
  };
  const started = Date.now();
  let response;
  try {
    response = await fetch(settings.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(180_000)
    });
  } catch (error) {
    const debug = {
      deliveryMode,
      endpoint: settings.baseUrl,
      model: settings.model,
      voiceId: settings.voiceId,
      keySource,
      textCharacters: String(text).length,
      elapsedMs: Date.now() - started,
      networkError: error.message
    };
    throw minimaxError(`无法连接 MiniMax：${error.message}`, debug);
  }
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  const debug = {
    deliveryMode,
    endpoint: settings.baseUrl,
    model: settings.model,
    voiceId: settings.voiceId,
    voiceSetting: requestBody.voice_setting,
    audioSetting: requestBody.audio_setting,
    keySource,
    textCharacters: String(text).length,
    httpStatus: response.status,
    elapsedMs: Date.now() - started,
    traceId: payload?.trace_id || "",
    baseResp: payload?.base_resp || null,
    extraInfo: payload?.extra_info || null,
    audioReturned: Boolean(payload?.data?.audio)
  };
  if (!response.ok || payload?.base_resp?.status_code) {
    throw minimaxError(payload?.base_resp?.status_msg || `MiniMax 请求失败：${response.status}`, debug);
  }
  const hex = payload?.data?.audio;
  if (!hex) throw minimaxError("MiniMax 没有返回音频数据", debug);
  return { buffer: Buffer.from(hex, "hex"), info: payload.extra_info || {}, debug };
}
