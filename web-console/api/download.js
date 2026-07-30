/**
 * 成品下载。
 *
 * 关键点：**不把文件流经这个函数**。GitHub 的 artifact 下载接口会 302 到一个
 * 带签名、短时有效的直链，这里只把那个直链转给浏览器，让浏览器直连去拉。
 * 几十上百 MB 的视频若走函数转发，必然撞上函数的响应时长和内存上限。
 *
 * 直链本身带签名且很快过期，所以不怕它出现在浏览器的下载记录里；
 * 而 token 始终留在服务端，从不下发。
 */
import { guard, gh, ghFail, repo } from "./_lib.js";

export default async function handler(req, res) {
  if (!guard(req, res)) return;

  const id = String(req.query?.id || "");
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: "id 必须是数字" });

  let response;
  try {
    response = await gh(`/repos/${repo()}/actions/artifacts/${id}/zip`, { redirect: "manual" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  const location = response.headers.get("location");
  if (!location) {
    if (!response.ok) return ghFail(res, response);
    return res.status(502).json({ error: "GitHub 没给下载直链，artifact 可能已过期（默认存 90 天）" });
  }

  res.setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store");
  return res.status(302).end();
}
