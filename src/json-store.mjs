import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function deepMerge(base, patch) {
  if (Array.isArray(patch)) return [...patch];
  if (!patch || typeof patch !== "object") return patch;
  const result = { ...(base && typeof base === "object" ? base : {}) };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? deepMerge(result[key], value)
      : value;
  }
  return result;
}

export async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
