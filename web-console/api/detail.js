/**
 * 单次运行的详情：跑到哪一步了、哪步失败了、有哪些成品可下载。
 *
 * 一次运行 20 分钟、十来个步骤，只看「成功/失败」等于没有信息。
 * 这里把每个 step 的状态摊开，失败时能直接看出断在选题、TTS 还是视频。
 */
import { guard, gh, ghFail, repo } from "./_lib.js";

export default async function handler(req, res) {
  if (!guard(req, res)) return;

  const runId = String(req.query?.run || "");
  // 这个值要拼进 API 路径，只允许纯数字。
  if (!/^\d+$/.test(runId)) return res.status(400).json({ error: "run 必须是数字 id" });

  const target = repo();
  let jobsRes;
  let artRes;
  try {
    [jobsRes, artRes] = await Promise.all([
      gh(`/repos/${target}/actions/runs/${runId}/jobs`),
      gh(`/repos/${target}/actions/runs/${runId}/artifacts`)
    ]);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  if (!jobsRes.ok) return ghFail(res, jobsRes);

  const jobsData = await jobsRes.json();
  const jobs = (jobsData.jobs || []).map((j) => ({
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    started: j.started_at,
    completed: j.completed_at,
    steps: (j.steps || []).map((s) => ({
      number: s.number,
      name: s.name,
      status: s.status,
      conclusion: s.conclusion,
      started: s.started_at,
      completed: s.completed_at
    }))
  }));

  // artifacts 拿不到不算致命 —— 运行中本来就还没有，别因此让整个详情页挂掉。
  let artifacts = [];
  if (artRes.ok) {
    const artData = await artRes.json();
    artifacts = (artData.artifacts || [])
      .filter((a) => !a.expired)
      .map((a) => ({ id: a.id, name: a.name, bytes: a.size_in_bytes, created: a.created_at }));
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ jobs, artifacts });
}
