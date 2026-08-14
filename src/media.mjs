import { createHash } from "node:crypto";
import { access, mkdir, readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

export function resolveMediaBinary(configured, type) {
  if (configured && configured !== "bundled") return configured;
  return type === "ffprobe" ? ffprobeStatic.path : ffmpegStatic;
}

export class CancelledError extends Error {
  constructor(message = "任务已取消") {
    super(message);
    this.name = "CancelledError";
    this.cancelled = true;
  }
}

function run(command, args, { duration = 0, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    // 取消时必须真的把 ffmpeg 杀掉。只让上层 await 的 Promise 提前 reject
    // 是不够的：进程会继续吃满 CPU 把视频导完，还会把一个用户已经不要的
    // 文件写进成品目录。
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3000).unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let stdout = "";
    let stderr = "";
    let progressBuffer = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!onProgress || !duration) return;
      progressBuffer += text;
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || "";
      for (const line of lines) {
        const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
        if (match) onProgress(Math.min(0.99, Number(match[1]) / 1_000_000 / duration));
        if (line === "progress=end") onProgress(1);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(cancelled ? new CancelledError() : error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (cancelled) return reject(new CancelledError());
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(stderr || `${command} 退出码 ${code}`));
    });
  });
}

const VIDEO_PROFILES = {
  compact: { id: "compact", width: 720, height: 1280, fps: 24, crf: 29, preset: "medium", audioBitrate: "96k" },
  balanced: { id: "balanced", width: 720, height: 1280, fps: 24, crf: 26, preset: "medium", audioBitrate: "128k" },
  high: { id: "high", width: 1080, height: 1920, fps: 30, crf: 23, preset: "medium", audioBitrate: "160k" }
};

export function resolveVideoProfile(media = {}) {
  return VIDEO_PROFILES[media.videoQuality] || VIDEO_PROFILES.balanced;
}

export async function checkBinary(command) {
  try {
    await run(command, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

export async function probeDuration(ffprobePath, file) {
  const { stdout } = await run(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]);
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error(`无法读取音频时长：${file}`);
  return seconds;
}

async function listFiles(dir, extensions) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())).map((entry) => path.join(dir, entry.name)).sort();
  } catch {
    return [];
  }
}

export async function selectDatedAsset(root, date, extensions, { strategy = "dated-seed", random = Math.random } = {}) {
  if (!root) throw new Error("素材目录尚未设置");
  const resolved = path.resolve(root);
  const rootFiles = await listFiles(resolved, extensions);
  const tiers = [
    await listFiles(path.join(resolved, date), extensions),
    rootFiles.filter((file) => path.basename(file).includes(date)),
    [
      ...await listFiles(path.join(resolved, "通用"), extensions),
      ...await listFiles(path.join(resolved, "common"), extensions)
    ],
    rootFiles
  ];
  const candidates = tiers.find((tier) => tier.length) || [];
  const unique = [...new Set(candidates)];
  if (!unique.length) throw new Error(`在 ${resolved} 中找不到 ${date} 对应素材`);
  if (strategy === "random") {
    const index = Math.min(unique.length - 1, Math.max(0, Math.floor(Number(random()) * unique.length)));
    return unique[index];
  }
  const seed = Number.parseInt(createHash("sha256").update(`${date}:${resolved}`).digest("hex").slice(0, 8), 16);
  return unique[seed % unique.length];
}

export async function renderAudio(config, { voicePath, bgmPath, outputAudio, onProgress, signal } = {}) {
  const media = config.media;
  const ffmpeg = resolveMediaBinary(media.ffmpegPath, "ffmpeg");
  const ffprobe = resolveMediaBinary(media.ffprobePath, "ffprobe");
  await Promise.all([access(voicePath), access(bgmPath)]);
  await mkdir(path.dirname(outputAudio), { recursive: true });
  const voiceDuration = await probeDuration(ffprobe, voicePath);
  const intro = Number(media.introSeconds);
  const fade = Number(media.fadeSeconds);
  const total = intro + voiceDuration + fade;
  const fadeStart = intro + voiceDuration;
  const gain = Number(media.bgmGainDb);
  const filter = [
    `[0:a]adelay=${Math.round(intro * 1000)}:all=1[voice]`,
    `[1:a]volume=${gain}dB,atrim=0:${total.toFixed(3)},afade=t=out:st=${fadeStart.toFixed(3)}:d=${fade.toFixed(3)}[bgm]`,
    `[bgm][voice]amix=inputs=2:duration=longest:normalize=0,atrim=0:${total.toFixed(3)},alimiter=limit=0.95:level=false[aout]`
  ].join(";");
  await run(ffmpeg, [
    "-y", "-i", voicePath, "-stream_loop", "-1", "-i", bgmPath,
    "-filter_complex", filter, "-map", "[aout]", "-c:a", "libmp3lame", "-b:a", "192k",
    "-progress", "pipe:1", "-nostats", outputAudio
  ], { duration: total, onProgress, signal });
  const outputAudioSize = (await stat(outputAudio)).size;
  return { voiceDuration, totalDuration: total, outputAudio, outputAudioSize };
}

export function resolveSequencedVideoPlan(totalDuration, introDuration, endFadeSeconds = 5) {
  const total = Math.max(0, Number(totalDuration || 0));
  const intro = Math.min(total, Math.max(0, Number(introDuration || 0)));
  const loop = Math.max(0, total - intro);
  const fade = Math.min(total, Math.max(0, Number(endFadeSeconds || 0)));
  return {
    totalDuration: total,
    introDuration: intro,
    loopDuration: loop,
    endFadeSeconds: fade,
    fadeStart: Math.max(0, total - fade)
  };
}

/**
 * 把一段视频改造成**首尾真的接得上**的循环片。
 *
 * 为什么需要：生视频那边虽然用 keyframes 模式把同一张图同时喂给首帧和尾帧，
 * 但模型只是「尽量」回到原样，做不到逐像素一致。2026-08-14 实测五条片子，
 * 接缝处的跳变和片内相邻帧跳变的差值是 +1.4 ~ −7.3 dB —— 画面越安静的那条
 * 反而越糟（渡口夜泊 −7.3）。原因不难理解：片内本来就几乎不动的话，
 * 接缝那点差异就没有东西能盖住它，一循环就看见「顿一下」。
 * 靠改提示词是解决不了的，模型只能尽力，保证得在这一步做。
 *
 * 做法（输出比输入短 fade 秒）：
 *   头 = 原片 [0, fade]
 *   尾 = 原片 [L, D]        （L = D - fade）
 *   中 = 原片 [fade, L]
 *   输出 = xfade(尾 → 头) ++ 中
 *
 * 于是输出的第一帧 = 原片第 L 帧，输出的最后一帧也 = 原片第 L 帧，
 * 首尾天然重合，接缝由构造保证，而不是靠模型自觉。
 *
 * 为什么不用「正放 + 倒放」的乒乓法：那能得到数学上完美的循环，但水会倒流、
 * 雪会倒着往上飘、烛火会反着抖 —— 在助眠片里这种不自然比一点接缝更刺眼。
 */
export async function makeSeamlessLoop(config, inputPath, outputPath, { fadeSeconds = 0.4, onProgress, signal } = {}) {
  const media = config.media || {};
  const ffmpeg = resolveMediaBinary(media.ffmpegPath, "ffmpeg");
  const ffprobe = resolveMediaBinary(media.ffprobePath, "ffprobe");
  const total = await probeDuration(ffprobe, inputPath);
  // 交叉段不能吃掉整条片子：留够中段，否则 concat 会拿到空输入。
  // 上限取三分之一是经验值 —— 5 秒片配 0.4 秒交叉，肉眼看不出被截短。
  const fade = Math.max(0.05, Math.min(Number(fadeSeconds) || 0.4, total / 3));
  const loopEnd = total - fade;
  await mkdir(path.dirname(outputPath), { recursive: true });
  await run(ffmpeg, [
    "-y", "-i", inputPath,
    "-filter_complex",
    `[0:v]trim=${loopEnd}:${total},setpts=PTS-STARTPTS[tail];`
    + `[0:v]trim=0:${fade},setpts=PTS-STARTPTS[head];`
    + `[0:v]trim=${fade}:${loopEnd},setpts=PTS-STARTPTS[mid];`
    + `[tail][head]xfade=transition=fade:duration=${fade}:offset=0[joined];`
    + `[joined][mid]concat=n=2:v=1:a=0[v]`,
    "-map", "[v]", "-an",
    "-c:v", "libx264", "-crf", "18", "-preset", "medium",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outputPath
  ], { onProgress, signal });
  return { outputPath, sourceDuration: total, loopDuration: loopEnd, fadeSeconds: fade };
}

export async function renderVideo(config, {
  audioPath,
  audioDuration,
  videoPath,
  introVideoPath,
  loopVideoPath,
  endFadeSeconds = 0,
  outputVideo,
  onProgress,
  signal
}) {
  const media = config.media;
  const profile = resolveVideoProfile(media);
  const ffmpeg = resolveMediaBinary(media.ffmpegPath, "ffmpeg");
  const ffprobe = resolveMediaBinary(media.ffprobePath, "ffprobe");
  await access(audioPath);
  await mkdir(path.dirname(outputVideo), { recursive: true });
  const duration = Number(audioDuration) || await probeDuration(ffprobe, audioPath);
  const normalize = `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=increase,crop=${profile.width}:${profile.height},fps=${profile.fps},setsar=1,format=yuv420p`;
  let visualMode = "library-loop";
  let plan = resolveSequencedVideoPlan(duration, 0, endFadeSeconds);
  let args;

  if (introVideoPath && loopVideoPath) {
    await Promise.all([access(introVideoPath), access(loopVideoPath)]);
    const introSourceDuration = await probeDuration(ffprobe, introVideoPath);
    plan = resolveSequencedVideoPlan(duration, introSourceDuration, endFadeSeconds);
    const fade = plan.endFadeSeconds > 0
      ? `,fade=t=out:st=${plan.fadeStart.toFixed(3)}:d=${plan.endFadeSeconds.toFixed(3)}`
      : "";
    if (plan.loopDuration > 0.05) {
      const filter = [
        `[0:v]${normalize},trim=start=0:duration=${plan.introDuration.toFixed(3)},setpts=PTS-STARTPTS[intro]`,
        `[1:v]${normalize},trim=start=0:duration=${plan.loopDuration.toFixed(3)},setpts=PTS-STARTPTS[loop]`,
        `[intro][loop]concat=n=2:v=1:a=0,trim=duration=${plan.totalDuration.toFixed(3)}${fade},format=yuv420p[v]`
      ].join(";");
      args = [
        "-y", "-i", introVideoPath, "-stream_loop", "-1", "-i", loopVideoPath, "-i", audioPath,
        "-filter_complex", filter, "-map", "[v]", "-map", "2:a:0"
      ];
    } else {
      const filter = `[0:v]${normalize},trim=start=0:duration=${plan.totalDuration.toFixed(3)},setpts=PTS-STARTPTS${fade},format=yuv420p[v]`;
      args = ["-y", "-i", introVideoPath, "-i", audioPath, "-filter_complex", filter, "-map", "[v]", "-map", "1:a:0"];
    }
    visualMode = "agnes-intro-loop";
  } else {
    await access(videoPath);
    const fade = plan.endFadeSeconds > 0
      ? `,fade=t=out:st=${plan.fadeStart.toFixed(3)}:d=${plan.endFadeSeconds.toFixed(3)}`
      : "";
    args = [
      "-y", "-stream_loop", "-1", "-i", videoPath, "-i", audioPath,
      "-vf", `${normalize}${fade}`, "-map", "0:v:0", "-map", "1:a:0"
    ];
  }

  args.push(
    "-t", duration.toFixed(3),
    "-c:v", "libx264", "-preset", profile.preset, "-crf", String(profile.crf),
    "-c:a", "aac", "-b:a", profile.audioBitrate, "-shortest", "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats", outputVideo
  );
  await run(ffmpeg, args, { duration, onProgress, signal });
  const outputVideoSize = (await stat(outputVideo)).size;
  return {
    outputVideo,
    outputVideoSize,
    videoProfile: profile,
    visualMode,
    visualTimeline: plan
  };
}

export async function renderMedia(config, { voicePath, bgmPath, videoPath, outputAudio, outputVideo, onAudioProgress, onVideoProgress }) {
  const audio = await renderAudio(config, { voicePath, bgmPath, outputAudio, onProgress: onAudioProgress });
  const video = await renderVideo(config, {
    audioPath: outputAudio,
    audioDuration: audio.totalDuration,
    videoPath,
    outputVideo,
    onProgress: onVideoProgress
  });
  return { ...audio, ...video };
}
