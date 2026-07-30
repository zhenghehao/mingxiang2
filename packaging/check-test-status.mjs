import { readFile } from "node:fs/promises";

const status = JSON.parse(await readFile(process.env.STATUS_FILE, "utf8"));
if (
  !status.ok
  || !status.runtime.ffmpeg
  || !status.runtime.ffprobe
  || !status.runtime.agnes?.connected
  || !status.runtime.publisher?.connected
  || status.runtime.publisher?.platforms?.length !== 7
  || status.skills.length < 4
) {
  throw new Error("迁移包运行检查失败");
}
console.log(`PACKAGE_RUNTIME_OK=yes skills=${status.skills.length} draftPlatforms=${status.runtime.publisher.platforms.length}`);
