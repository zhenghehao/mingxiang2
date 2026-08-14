/**
 * 删除一个 artifact，腾出 GitHub 的存储配额。
 *
 * 为什么需要：一次成品动辄一百多 MB，artifact 默认存 90 天，跑得勤一点
 * 配额很快就满，满了之后**新的运行会上传失败**——而那时候片子已经跑完了，
 * 白烧一轮。所以「下载完就删」得是个随手能做的动作。
 *
 * 只接受 DELETE。这个函数一旦被 GET 触发，浏览器预取、爬虫、甚至
 * 手滑刷新都可能把成品删掉 —— 删除绝不能挂在幂等方法上。
 *
 * 权限：删 artifact 要 actions:write，和触发 workflow 是同一个权限，
 * 现有的 GITHUB_TOKEN 已经有了，不用另配。
 */
import { guard, gh, ghFail, repo } from "./_lib.js";

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== "DELETE") {
    res.setHeader("Allow", "DELETE");
    return res.status(405).json({ error: "只接受 DELETE" });
  }

  const id = String(req.query?.id || "");
  // 要拼进 API 路径，只允许纯数字 —— 和 download.js 同一条规矩
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: "id 必须是数字" });

  let response;
  try {
    response = await gh(`/repos/${repo()}/actions/artifacts/${id}`, { method: "DELETE" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  // 删成功是 204 No Content。404 当成「已经没了」按成功处理：
  // 用户要的是「这东西不占地方了」，而它确实不占了 —— 为一个已达成的目标
  // 弹一句红色报错，只会让人以为删失败了又去点一次。
  if (response.status === 204 || response.status === 404) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, id, alreadyGone: response.status === 404 });
  }
  return ghFail(res, response);
}
