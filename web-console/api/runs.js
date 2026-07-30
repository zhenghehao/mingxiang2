/**
 * 运行列表。前端轮询这个接口拿状态。
 *
 * 顺带当「会话还活着吗」的探针：401 就是要重新登录。
 */
import { guard, gh, ghFail, repo } from "./_lib.js";

export default async function handler(req, res) {
  if (!guard(req, res)) return;

  let response;
  try {
    response = await gh(`/repos/${repo()}/actions/runs?per_page=20`);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  if (!response.ok) return ghFail(res, response);

  const data = await response.json();
  const runs = (data.workflow_runs || []).map((r) => ({
    id: r.id,
    number: r.run_number,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    event: r.event,
    created: r.created_at,
    updated: r.updated_at,
    html: r.html_url
  }));

  // 列表接口不缓存：状态就是这个页面唯一的价值，缓存住了就等于坏了。
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ runs, total: data.total_count ?? runs.length });
}
