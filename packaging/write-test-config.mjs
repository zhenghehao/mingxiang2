import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const config = JSON.parse(await readFile(process.env.CONFIG_SOURCE, "utf8"));
const resources = path.join(process.env.APP_PATH, "Contents", "Resources", "app", "resources");
config.app.port = 4329;
config.app.outputRoot = path.join(process.env.TEST_DIR, "output");
config.app.runRoot = path.join(process.env.TEST_DIR, "work", "runs");
config.skillRoots = ["01-topic", "02-script", "03-minimax-tts", "04-publisher-copywriter"]
  .map((name) => path.join(resources, "skills", name));
config.media.bgmRoot = path.join(resources, "media", "bgm");
config.media.videoRoot = path.join(resources, "media", "video");
config.publishing.cli.path = "auto";
config.agnes.enabled = true;
config.agnes.embedded = true;
config.agnes.baseUrl = "http://127.0.0.1:8898";
config.agnes.projectRoot = path.join(process.env.APP_PATH, "Contents", "Resources", "app", "agnes");
await writeFile(process.env.CONFIG_TEST, JSON.stringify(config));
