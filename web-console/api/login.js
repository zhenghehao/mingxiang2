/**
 * 账号 + 口令登录。POST 登录，DELETE 退出。
 *
 * 账号和口令都只存在环境变量里（CONSOLE_USER / CONSOLE_PASSWORD），
 * 代码和仓库里都没有真值。
 */
import crypto from "node:crypto";
import { env, issue, setSession, clearSession, body, shape } from "./_lib.js";

/** 各自 sha256 再比：定长，常量时间，且不会从耗时里漏出长度。 */
function same(a, b) {
  return crypto.timingSafeEqual(
    crypto.createHash("sha256").update(String(a)).digest(),
    crypto.createHash("sha256").update(String(b)).digest()
  );
}

export default async function handler(req, res) {
  if (req.method === "DELETE") {
    clearSession(res);
    return res.status(200).json({ ok: true });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "只接受 POST" });

  let user;
  let password;
  let secret;
  try {
    user = env("CONSOLE_USER");
    password = env("CONSOLE_PASSWORD");
    secret = env("CONSOLE_SECRET");
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  const input = body(req);
  // 两个都要比，而且**先各自算完再合并**，不要短路。账号错就直接返回的话，
  // 「哪一个错了」会从响应时间里漏出来，等于把账号名送给爆破方。
  const userOk = same(input.user || "", user);
  const passOk = same(input.password || "", password);

  if (!(userOk && passOk)) {
    // 诊断只写**服务端日志**（Vercel 的 Runtime Logs，只有项目所有者看得到），
    // HTTP 响应里绝不带这些 —— 长度对爆破方也是信息。
    // 只打形状：位数、有没有被 trim 掉空白、哪一项不匹配。
    console.warn("[登录失败]",
      `账号${userOk ? "匹配" : "不匹配"}`,
      `口令${passOk ? "匹配" : "不匹配"}`,
      "｜配置侧:", shape("CONSOLE_USER"), shape("CONSOLE_PASSWORD"),
      "｜提交侧:", `账号${String(input.user || "").length}位`, `口令${String(input.password || "").length}位`);

    // 固定延迟：错就秒回的话，快慢本身就是可以拿来爆破的信号。
    await new Promise((r) => setTimeout(r, 400));
    // 不说是账号错还是口令错，同一句话。
    return res.status(401).json({ error: "账号或口令不对" });
  }

  setSession(res, issue(secret));
  return res.status(200).json({ ok: true });
}
