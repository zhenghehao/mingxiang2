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
    // 取 100 条再过滤。定时每 2 小时敲一次门，自动生成关掉时这些触发会被 job 的
    // if 条件跳过 —— 不占 runner、不花额度，但**照样留下一条运行记录**。一天 12 条，
    // 只取 20 条的话两天就把真正出了成品的那几条全挤出去了。
    response = await gh(`/repos/${repo()}/actions/runs?per_page=100`);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  if (!response.ok) return ghFail(res, response);

  const data = await response.json();
  const all = data.workflow_runs || [];
  // 跳过的记录对人没有信息量：它只说明「定时来过、但开关是关的」，而开关状态
  // 页面上本来就写着。留着只会淹掉有成品的那几条。
  const 有效 = all.filter((r) => r.conclusion !== "skipped");
  // 默认还是 20 条 —— 一屏能看完，翻页交给「更多」按钮。
  // 上限锁在 100：GitHub 一次最多返回 100 条 run，要更多得翻页，
  // 而攒到 100 条还找不到想要的，靠滚动也不是办法了。
  const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 20));
  const runs = 有效.slice(0, limit).map((r) => ({
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
  return res.status(200).json({
    runs,
    total: 有效.length,
    // 前端据此决定「更多」按钮还显不显示
    hasMore: 有效.length > runs.length,
    // 让前端能告诉用户「隐藏了 N 条定时跳过」，免得以为记录丢了
    skippedHidden: all.length - 有效.length
  });
}
