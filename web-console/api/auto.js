/**
 * 自动生成的总开关。
 *
 * GET  → 现在是开还是关，以及 cron 的频率
 * POST → 翻转（body: { on: true|false }）
 *
 * 开关的载体是仓库变量 AUTO_RUN（Actions Variables，不是 Secret —— 它不敏感，
 * 而且 Secret 读不回来，做开关得用 Variable）。
 * generate.yml 的 job 上有 `if: ... || vars.AUTO_RUN == 'on'`：关掉时定时触发
 * 会直接跳过整个 job，不占 runner、不消耗任何额度。
 *
 * 为什么不用 Vercel Cron：Hobby 计划的定时任务**一天只能跑一次**，做不到两小时
 * 一次。而且让 GitHub 自己敲自己的门，比让 Vercel 隔空触发少一个故障点。
 */
import { guard, gh, ghFail, repo, body } from "./_lib.js";

const NAME = "AUTO_RUN";

/**
 * 变量接口的 403 只有一个原因，直接把话说到底。
 *
 * 通用的 403 文案会说「需要 actions:write 和 contents:read」—— 那是别处的
 * 需求，照搬到这里就是把人往错的方向指。读写仓库变量要的是 Variables 权限，
 * 而且它**不在** Actions 权限里，是单独一项。
 */
function needVariables(res) {
  return res.status(502).json({
    error: "GitHub 403 · token 缺少 Variables 权限（这一项和 Actions 是分开的）",
    detail: "GitHub → Settings → Developer settings → Fine-grained tokens → 编辑这个 token"
      + " → Permissions → Add permissions → 找 Variables → 设成 Read and write → Update。"
      + "权限在 GitHub 侧即时生效，改完刷新本页即可，不用重新部署 Vercel。"
  });
}

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  const target = repo();

  if (req.method === "GET") {
    let r;
    try {
      r = await gh(`/repos/${target}/actions/variables/${NAME}`);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
    // 变量还没建过 → 404，等价于「关」，不是错误。
    if (r.status === 404) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ on: false, exists: false });
    }
    if (r.status === 403) return needVariables(res);
    if (!r.ok) return ghFail(res, r);
    const data = await r.json();
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ on: data.value === "on", exists: true });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "只接受 GET / POST" });

  const on = body(req).on === true;
  const value = on ? "on" : "off";

  let r;
  try {
    // 先试更新；变量不存在时 GitHub 返回 404，再走创建。
    r = await gh(`/repos/${target}/actions/variables/${NAME}`, {
      method: "PATCH",
      body: JSON.stringify({ name: NAME, value })
    });
    if (r.status === 404) {
      r = await gh(`/repos/${target}/actions/variables`, {
        method: "POST",
        body: JSON.stringify({ name: NAME, value })
      });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  // PATCH 成功是 204，POST 创建成功是 201。
  if (r.status !== 204 && r.status !== 201) {
    if (r.status === 403) return needVariables(res);
    return ghFail(res, r);
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ on });
}
