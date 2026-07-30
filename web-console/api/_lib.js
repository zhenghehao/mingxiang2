/**
 * 控制台的共享底座：会话、鉴权、GitHub 调用。
 *
 * 文件名带下划线，Vercel 不会把它暴露成路由。
 *
 * 会话不落任何存储：签名 cookie 自带过期时间，服务端只验签。
 * 这台控制台是单人用的遥控器，没有多用户、没有数据库，也不需要。
 */
import crypto from "node:crypto";

const COOKIE = "mx_session";
const TTL_SECONDS = 12 * 60 * 60;

/**
 * 缺环境变量要当场喊出来。静默降级会变成「登录页能打开但永远登不进去」。
 *
 * 值一律 trim：往 Vercel 的输入框里粘贴时很容易带进尾部空格或换行，而这里的
 * 比较是精确的，带了尾部换行的值和不带的值不相等 —— 表现就是口令明明
 * 填对了却一直说不对，且没有任何线索。首尾空白从来不是密钥的一部分。
 */
export function env(name) {
  const raw = process.env[name];
  if (!raw || !String(raw).trim()) throw new Error(`缺少环境变量 ${name}`);
  return String(raw).trim();
}

/** 只暴露形状，不暴露内容 —— 给日志用，和 check-secrets.mjs 同一套脱敏规矩。 */
export function shape(name) {
  const raw = process.env[name];
  if (raw === undefined) return `${name}=未设置`;
  const s = String(raw);
  const flags = [];
  if (s !== s.trim()) flags.push("首尾有空白（已自动 trim）");
  if (/[\r\n]/.test(s)) flags.push("含换行");
  return `${name}=${s.trim().length}位${flags.length ? "，" + flags.join("、") : ""}`;
}

function hmac(body, secret) {
  return crypto.createHmac("sha256", secret).update(body).digest("base64url");
}

export function issue(secret) {
  const body = Buffer.from(JSON.stringify({ exp: Date.now() + TTL_SECONDS * 1000 })).toString("base64url");
  return `${body}.${hmac(body, secret)}`;
}

export function valid(token, secret) {
  const [body, mac] = String(token || "").split(".");
  if (!body || !mac) return false;
  const expect = hmac(body, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  // 长度不等时 timingSafeEqual 会直接抛，所以先比长度。
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1));
  }
  return "";
}

export function setSession(res, token) {
  // HttpOnly：JS 读不到，XSS 也偷不走。Secure + SameSite=Strict：只走 HTTPS，
  // 且跨站请求不带 cookie，省掉一整类 CSRF。
  res.setHeader("Set-Cookie",
    `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${TTL_SECONDS}`);
}

export function clearSession(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}

/** 每个接口第一行都调它。返回 false 时响应已经写好了，直接 return。 */
export function guard(req, res) {
  try {
    if (valid(readCookie(req, COOKIE), env("CONSOLE_SECRET"))) return true;
  } catch (error) {
    res.status(500).json({ error: error.message });
    return false;
  }
  // code 是给前端认的：只有这个才代表「你的会话没了，去重新登录」。
  // 上游 GitHub 的 401 不能共用这个语义，否则 token 填错会被显示成
  // 「口令过期」，把人引去查密码，而真正的问题在 token。
  res.status(401).json({ error: "未登录", code: "no_session" });
  return false;
}

export function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body || "{}");
  } catch {
    return {};
  }
}

export function repo() {
  const value = env("GITHUB_REPO");
  // owner/repo 之外的东西一律拒绝：这个值会拼进 API 路径，
  // 放任它就等于把路径拼接的口子留给环境变量。
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`GITHUB_REPO 格式不对，应该是 owner/repo，当前是「${value}」`);
  }
  return value;
}

export async function gh(path, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    }
  });
}

/** GitHub 的报错原样透出来，不然排查时只能看到一个光秃秃的 500。 */
export async function ghFail(res, response) {
  const text = await response.text().catch(() => "");
  let hint = "";
  if (response.status === 401) hint = "GITHUB_TOKEN 无效或过期";
  else if (response.status === 403) hint = "token 权限不够，需要 actions:write 和 contents:read";
  else if (response.status === 404) hint = "仓库或 workflow 找不到，检查 GITHUB_REPO 和分支名";

  // 上游的 401/403 **不能原样透传**。那是「我们的 token 不行」，不是
  // 「访客没登录」；照抄成 401 会让前端把它当成会话失效，把人踢去重输口令。
  // 对访客来说这是上游故障，所以是 502。
  const status = response.status === 401 || response.status === 403 ? 502 : response.status;
  return res.status(status).json({
    error: `GitHub ${response.status}${hint ? " · " + hint : ""}`,
    detail: text.slice(0, 400)
  });
}
