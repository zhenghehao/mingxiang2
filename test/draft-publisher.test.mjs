import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDraftHandoff,
  DRAFT_PLATFORMS
} from "../src/draft-publisher.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("七平台交接清单使用真实媒体、双封面和各平台独立文案", () => {
  const manifest = {
    title: "森林入睡（10分钟）",
    media: {
      outputVideo: "/tmp/final.mp4",
      outputAudio: "/tmp/final.mp3"
    },
    cover: {
      covers: [
        { aspect: "4:3", path: "/tmp/4x3.png" },
        { aspect: "16:9", path: "/tmp/16x9.png" }
      ]
    }
  };
  const platforms = Object.fromEntries(DRAFT_PLATFORMS.map((platform) => [
    platform.copyKey,
    {
      title: `${platform.label}森林入睡（10分钟）`,
      description: `${platform.label}的独立简介`,
      hashtags: ["#冥想", "#助眠"]
    }
  ]));
  platforms.wechat_channels.short_title = "睡前森林";

  const handoff = buildDraftHandoff({
    runId: "2026-07-26-1234567890",
    manifest,
    text: { copy: { platforms } }
  });

  assert.equal(handoff.platforms.length, 7);
  assert.deepEqual(handoff.assets, {
    videoPath: "/tmp/final.mp4",
    audioPath: "/tmp/final.mp3",
    cover4x3Path: "/tmp/4x3.png",
    cover16x9Path: "/tmp/16x9.png",
    // 旧清单（这个 fixture 就是）没有这个字段，要落成空串而不是 undefined ——
    // 界面拿它去拼 URL，undefined 会变成字符串 "undefined" 打到服务端
    copyTxtPath: ""
  });

  // 新清单里有路径时要如实带出来
  const withTxt = buildDraftHandoff({
    runId: "2026-07-26-1234567890",
    manifest: { ...manifest, assets: { copyTxtPath: "/tmp/文本/04-跨平台发布文案.txt" } },
    text: { copy: { platforms } }
  });
  assert.equal(withTxt.assets.copyTxtPath, "/tmp/文本/04-跨平台发布文案.txt");
  for (const platform of handoff.platforms) {
    assert.doesNotMatch(platform.copy.title, /10分钟/);
    assert.equal(platform.copy.tags[0], "冥想");
    assert.equal(
      platform.mediaPath,
      platform.kind === "audio" ? "/tmp/final.mp3" : "/tmp/final.mp4"
    );
  }
  assert.equal(
    handoff.platforms.find((item) => item.name === "shipinhao").copy.shortTitle,
    "睡前森林"
  );
});

test("主应用只暴露草稿任务，旧 8199 正式发布器已移除", async () => {
  const [server, workflow, browserApp, browserHtml] = await Promise.all([
    readFile(path.join(ROOT, "server.mjs"), "utf8"),
    readFile(path.join(ROOT, "src/workflow.mjs"), "utf8"),
    readFile(path.join(ROOT, "public/app.js"), "utf8"),
    readFile(path.join(ROOT, "public/index.html"), "utf8")
  ]);
  const active = `${server}\n${workflow}\n${browserApp}\n${browserHtml}`;
  assert.doesNotMatch(active, /127\.0\.0\.1:8199/);
  assert.doesNotMatch(active, /\/api\/publish(?:["'`?])/);
  assert.doesNotMatch(active, /发布成功/);
  assert.match(server, /\/api\/draft-publisher\/jobs/);
  assert.match(workflow, /ready-for-draft/);
  assert.match(browserHtml, /存入草稿箱/);
});

test("五个视频适配器只落草稿，两个音频适配器停在人工确认前", async () => {
  const adapterRoot = path.join(ROOT, "extensions/draft-publisher/app");
  const [douyin, kuaishou, xhs, shipinhao, extended, backend] = await Promise.all([
    readFile(path.join(adapterRoot, "uploader/douyin_uploader/main.py"), "utf8"),
    readFile(path.join(adapterRoot, "uploader/ks_uploader/main.py"), "utf8"),
    readFile(path.join(adapterRoot, "uploader/xiaohongshu_uploader/main.py"), "utf8"),
    readFile(path.join(adapterRoot, "uploader/tencent_uploader/main.py"), "utf8"),
    readFile(path.join(adapterRoot, "uploader/extended_draft_uploader.py"), "utf8"),
    readFile(path.join(adapterRoot, "sau_backend.py"), "utf8")
  ]);
  for (const source of [douyin, kuaishou, xhs, shipinhao]) {
    assert.match(source, /save_draft_only/);
  }
  assert.match(extended, /span\.submit-draft/);
  assert.match(extended, /prepared_for_manual_review/);
  assert.match(extended, /健康/);
  assert.match(backend, /正式发布入口已永久禁用/);
  assert.match(backend, /批量正式发布入口已永久禁用/);
});
