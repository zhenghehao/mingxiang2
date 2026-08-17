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

/**
 * 量一段音频的整体响度（EBU R128 的 integrated loudness，单位 LUFS）。
 *
 * 量不出来就返回 null，由调用方决定怎么办 —— 背景音响度这件事不值得让
 * 整条流水线挂掉。
 */
export async function measureLoudness(ffmpegPath, file) {
  // ebur128 的统计摘要走 stderr，而且是 info 级别 —— 加 -v error 会把它一起吞掉，
  // 于是量出来永远是空。这个坑踩过一次，记在这儿。
  const { stderr } = await run(ffmpegPath, [
    "-hide_banner", "-nostats", "-i", file, "-af", "ebur128", "-f", "null", "-"
  ]).catch(() => ({ stderr: "" }));
  const tail = stderr.slice(stderr.lastIndexOf("Integrated loudness"));
  const match = tail.match(/I:\s*(-?[\d.]+)\s*LUFS/);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) ? value : null;
}

/**
 * 背景音该用多少增益。
 *
 * 直接用 bgmGainDb 的问题：曲库里 180 首曲子本身响度就不齐（实测随手两首
 * 差 1.2dB，全库跨度只会更大）。同一个 gain，随机到响的那首就偏吵、
 * 闷的那首就偏弱 —— 用户是拿其中一首定的音量，其余全部围着它上下摆。
 *
 * 所以先把每首都归一到同一个基准响度，再套 gain。这样 bgmGainDb 才是个
 * 说了算的旋钮，而不是「看今天抽到哪首」。
 *
 * 用**静态增益**而不是 loudnorm 滤镜，有两个原因：
 *   1. 背景音是 -stream_loop -1 无限循环的，动态归一化会在循环接缝处
 *      按不同的历史窗口做出不同的处理，接缝就露出来了。
 *   2. 这些是氛围音乐，本来就不需要压缩动态；静态增益不引入任何处理痕迹。
 *
 * 量不出响度时退回原来的行为（只用 bgmGainDb），并把原因交给调用方去说。
 */
export function resolveBgmGain(gainDb, measuredLufs, targetLufs) {
  const gain = Number(gainDb) || 0;
  // null / "" / undefined 必须先挡掉再转数字 —— Number(null) 是 0 而不是 NaN。
  // 不挡的话「bgmTargetLufs: null 关掉归一化」会被解释成「基准是 0 LUFS」，
  // 于是每首曲子都被推高十几 dB，成品震耳欲聋。这是 JS 里最容易中的一枪。
  const target = targetLufs === null || targetLufs === undefined || targetLufs === ""
    ? NaN
    : Number(targetLufs);
  if (!Number.isFinite(measuredLufs) || !Number.isFinite(target)) {
    return { gain, normalized: false, delta: 0 };
  }
  // 比基准响的曲子往下压，闷的往上抬。
  // 取两位小数：这个值要拼进 ffmpeg 的滤镜字符串，
  // -8.199999999999999dB 既难看又让每次的命令行不可复现。
  const delta = Number((target - measuredLufs).toFixed(2));
  return { gain: Number((gain + delta).toFixed(2)), normalized: true, delta };
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
  // 先把这首背景音归一到基准响度，再套 bgmGainDb（见 resolveBgmGain）
  // 同上：不能写成 Number.isFinite(Number(media.bgmTargetLufs))，
  // null 会被转成 0 从而误判成「配了基准」，白量一遍还算出错的增益。
  const hasTarget = media.bgmTargetLufs !== null && media.bgmTargetLufs !== undefined
    && media.bgmTargetLufs !== "" && Number.isFinite(Number(media.bgmTargetLufs));
  const measured = hasTarget ? await measureLoudness(ffmpeg, bgmPath) : null;
  const { gain, normalized, delta } = resolveBgmGain(media.bgmGainDb, measured, media.bgmTargetLufs);
  onProgress?.(0);
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
  return {
    voiceDuration, totalDuration: total, outputAudio, outputAudioSize,
    // 记下这次背景音到底被推了多少 —— 成品听感不对时，第一个要看的就是它
    bgm: {
      path: bgmPath,
      measuredLufs: measured,
      targetLufs: normalized ? Number(media.bgmTargetLufs) : null,
      normalized,
      appliedGainDb: Number(gain.toFixed(2)),
      correctionDb: Number(delta.toFixed(2))
    }
  };
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
