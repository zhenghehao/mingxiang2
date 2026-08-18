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
 *
 * 带上 ?run=<id> 时，成品删完还会把**那条运行记录本身**一起删掉，让它从列表里消失。
 * 用户的原话：「下载一条，可以删除一条，不会乱」—— 只删附件的话列表里会留下
 * 一条点开什么也没有的空壳，攒多了比不删还乱。
 * 前提是这条 run 已经没有别的成品了，见下面。
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
  const runId = String(req.query?.run || "");
  if (runId && !/^\d+$/.test(runId)) return res.status(400).json({ error: "run 必须是数字" });

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
    const runDeleted = runId ? await 删掉空壳记录(runId) : false;
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, id, alreadyGone: response.status === 404, runDeleted });
  }
  return ghFail(res, response);
}

/**
 * 删掉一条已经没有成品的运行记录。
 *
 * 先查还剩几个附件再决定删不删：一条 run 理论上可以挂多个 artifact，
 * 删了其中一个就把整条记录端掉，会把**还没下载的那几个**一起带走。
 * 现在的流水线一条 run 只产一个包，所以这个检查平时都会通过 ——
 * 它防的是以后有人往 upload-artifact 里加第二个包时，这里悄悄开始吃人。
 *
 * 任何一步不顺就返回 false：成品已经删掉了，那才是用户按下按钮时要的结果；
 * 为「壳没删掉」把整个请求判失败，只会让人以为成品还在，再去点一次。
 */
async function 删掉空壳记录(runId) {
  try {
    const left = await gh(`/repos/${repo()}/actions/runs/${runId}/artifacts?per_page=100`);
    if (!left.ok) return false;
    const data = await left.json();
    const 还剩 = (data.artifacts || []).filter((a) => !a.expired).length;
    if (还剩 > 0) return false;
    const del = await gh(`/repos/${repo()}/actions/runs/${runId}`, { method: "DELETE" });
    return del.status === 204 || del.status === 404;
  } catch {
    return false;
  }
}
