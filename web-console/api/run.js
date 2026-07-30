/**
 * 触发一次 Actions 运行。
 *
 * workflow 名走白名单：绝不把前端传来的字符串直接拼进 API 路径，
 * 否则等于把「触发这个仓库里任意 workflow」的能力开放给了请求方。
 */
import { guard, gh, ghFail, repo, body } from "./_lib.js";

const WORKFLOWS = {
  preflight: "preflight.yml",
  generate: "generate.yml"
};

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "只接受 POST" });

  const input = body(req);
  const file = WORKFLOWS[input.workflow];
  if (!file) {
    return res.status(400).json({ error: `workflow 只能是 ${Object.keys(WORKFLOWS).join(" / ")}` });
  }

  const inputs = {};
  if (file === WORKFLOWS.generate) {
    // 这三个会原样进 workflow 的 inputs，再进 shell 命令行，所以逐个收紧：
    // 日期只允许 YYYY-MM-DD，时段只认两个字面量，时长夹在 1–60。
    const date = String(input.date || "").trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "日期格式要 YYYY-MM-DD，留空＝今天" });
    }
    inputs.date = date;
    inputs.brief = input.brief === "中午" ? "中午" : "晚上";
    const minutes = Number(input.minutes);
    inputs.minutes = String(Number.isFinite(minutes) ? Math.min(60, Math.max(1, Math.round(minutes))) : 10);
  }

  let response;
  try {
    response = await gh(`/repos/${repo()}/actions/workflows/${file}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: process.env.TARGET_REF || "main", inputs })
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  // dispatch 成功是 204 No Content，没有响应体。
  if (response.status !== 204) return ghFail(res, response);

  // GitHub 不在 dispatch 响应里返回 run id，新 run 也要一两秒才出现在列表里。
  // 前端据此提示「已提交」，然后靠轮询列表把它认出来。
  return res.status(202).json({ ok: true, workflow: file, inputs });
}
