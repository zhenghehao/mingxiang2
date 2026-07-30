#!/bin/zsh
set -euo pipefail
umask 077

project_root="$(cd "$(dirname "$0")/.." && pwd)"
desktop_root="/Users/shareit/Desktop"
build_root="$(/usr/bin/mktemp -d /tmp/meditation-workflow2-intel.XXXXXX)"
stage_name="冥想一键工作流2-Intel-完整迁移包-含API"
stage="$build_root/$stage_name"
zip_path="$desktop_root/${stage_name}.zip"
app="$stage/眠屿工作台.app"
contents="$app/Contents"
resources="$contents/Resources"
app_root="$resources/app"
credentials="$stage/credentials"

cleanup() {
  if [[ "$build_root" == /tmp/meditation-workflow2-intel.* ]]; then
    /bin/rm -rf "$build_root"
  fi
}
trap cleanup EXIT

/bin/mkdir -p "$contents/MacOS" "$resources/runtime" "$app_root" "$credentials"

# 主应用：带 Intel Node 依赖、FFmpeg、FFprobe 和内嵌 Python；不带历史成品与运行记录。
/usr/bin/rsync -a \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude '.playwright-cli' \
  --exclude '__pycache__' \
  --exclude 'draftQueue' \
  --exclude 'output' \
  --exclude 'outputs' \
  --exclude 'work' \
  --exclude 'packaging' \
  --exclude '迁移包-*' \
  --exclude '冥想一键工作流2-Intel-*' \
  "$project_root/" "$app_root/"

# Agnes 完整离线依赖，目标机无需 npm install。
/bin/mkdir -p "$app_root/agnes/output"
/usr/bin/rsync -a \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude 'output' \
  "$desktop_root/agnes-playground/" "$app_root/agnes/"

/bin/cp "$project_root/packaging/Info.plist" "$contents/Info.plist"
/bin/cp "$project_root/packaging/sleepflow-launcher" "$contents/MacOS/sleepflow-launcher"
/bin/cp "/Users/shareit/.local/bin/node" "$resources/runtime/node"
/bin/chmod 755 "$contents/MacOS/sleepflow-launcher" "$resources/runtime/node"

if [[ -x "/Users/shareit/.hermes/node/lib/node_modules/@yixiaoermail/cli/bin-native/yxer" ]]; then
  /bin/cp "/Users/shareit/.hermes/node/lib/node_modules/@yixiaoermail/cli/bin-native/yxer" "$resources/runtime/yxer"
  /bin/chmod 755 "$resources/runtime/yxer"
fi

# 运行所需素材、当前 Skills 和 B站默认双封面。
/bin/mkdir -p "$app_root/resources/media/bgm" "$app_root/resources/media/video"
/usr/bin/rsync -a "$desktop_root/未命名文件夹 6/未命名文件夹 2/" "$app_root/resources/media/bgm/"
/usr/bin/rsync -a "$desktop_root/未命名文件夹 6/未命名文件夹 4/" "$app_root/resources/media/video/"
/bin/mkdir -p "$app_root/resources/default-covers"
/usr/bin/rsync -a --exclude '.DS_Store' "$desktop_root/bilibili/" "$app_root/resources/default-covers/"

/bin/mkdir -p "$app_root/resources/skills/all-codex-skills"
/usr/bin/rsync -a --exclude '__pycache__' "/Users/shareit/.codex/skills/" "$app_root/resources/skills/all-codex-skills/"
/bin/mkdir -p \
  "$app_root/resources/skills/01-topic" \
  "$app_root/resources/skills/02-script" \
  "$app_root/resources/skills/03-minimax-tts" \
  "$app_root/resources/skills/04-publisher-copywriter"
/bin/cp "$desktop_root/未命名文件夹/助眠选题器-SKILL 2.md" "$app_root/resources/skills/01-topic/SKILL.md"
/bin/cp "$desktop_root/未命名文件夹/催眠入睡文稿写作引擎-SKILL-v2.1 2.md" "$app_root/resources/skills/02-script/SKILL.md"
/bin/cp "$desktop_root/眠屿四个Skills/minimax-meditation-tts-ultimate-v3/SKILL.md" "$app_root/resources/skills/03-minimax-tts/SKILL.md"
/bin/cp "/Users/shareit/.codex/skills/sleep-content-publisher-copywriter/SKILL.md" "$app_root/resources/skills/04-publisher-copywriter/SKILL.md"

# 原始密钥与配置完整保留在 ZIP 内；这里只读取，不打印真实值。
for account in minimax-subscription-key minimax-api-key text-provider-api-key; do
  target="$credentials/.$account"
  temporary="$target.tmp"
  if /usr/bin/security find-generic-password \
       -s com.shareit.sleepflow-studio -a "$account" -w >"$temporary" 2>/dev/null; then
    /bin/mv "$temporary" "$target"
  elif [[ -s "$project_root/迁移包-20260726-含密钥/密钥-不要外传/$account.txt" ]]; then
    /bin/cp "$project_root/迁移包-20260726-含密钥/密钥-不要外传/$account.txt" "$target"
  else
    /bin/rm -f "$temporary"
    print -u2 -- "缺少必要密钥：$account"
    exit 1
  fi
done

for source in \
  "/Users/shareit/.yxer/config.json" \
  "/Users/shareit/.codex/auth.json" \
  "/Users/shareit/.codex/config.toml"; do
  if [[ ! -s "$source" ]]; then
    print -u2 -- "缺少必要配置：$source"
    exit 1
  fi
  /bin/cp "$source" "$credentials/${source:t}"
done

if [[ -s "/Users/shareit/.hermes/.env" ]]; then
  /bin/cp "/Users/shareit/.hermes/.env" "$credentials/hermes.env"
fi
if [[ -s "/Users/shareit/.gemini/.env" ]]; then
  /bin/cp "/Users/shareit/.gemini/.env" "$credentials/gemini.env"
fi
/bin/chmod 600 "$credentials"/* "$credentials"/.* 2>/dev/null || true

# 安装器和面向普通用户/另一智能体的文档。
/bin/cp "$project_root/packaging/installer.mjs" "$stage/installer.mjs"
/bin/cp "$project_root/packaging/安装眠屿工作台.command" "$stage/安装冥想一键工作流2.command"
/bin/cp "$project_root/packaging/使用说明.txt" "$stage/普通使用方法.txt"
/bin/cp "$project_root/packaging/首次登录步骤.md" "$stage/首次登录步骤.md"
/bin/cp "$project_root/packaging/故障排查.md" "$stage/故障排查.md"
/bin/cp "$project_root/AGENTS.md" "$stage/给智能体的接手说明.md"
/bin/cp "$project_root/docs/七平台草稿系统交接.md" "$stage/七平台草稿系统交接.md"
/bin/chmod 755 "$stage/安装冥想一键工作流2.command"

# 先签名，再进行架构和内容校验，保证清单对应 ZIP 中的最终字节。
/usr/bin/codesign --force --deep --sign - "$app" >/dev/null

architecture_report="$stage/Mach-O架构检查.txt"
print -r -- "要求：所有 Mach-O 文件必须包含 x86_64；目标系统 macOS 12+。" > "$architecture_report"
print -r -- "" >> "$architecture_report"
while IFS= read -r -d '' file; do
  description="$(/usr/bin/file -b "$file")"
  if [[ "$description" == *"Mach-O"* ]]; then
    relative="${file#$stage/}"
    print -r -- "$relative | $description" >> "$architecture_report"
    if [[ "$description" != *"x86_64"* ]]; then
      print -u2 -- "发现不兼容的 Mach-O：$relative"
      exit 1
    fi
  fi
done < <(/usr/bin/find "$stage" -type f -print0)

manifest="$stage/文件清单与SHA-256.txt"
print -r -- "以下 SHA-256 对应本文件之外的 ZIP 内全部文件。" > "$manifest"
print -r -- "生成时间：$(/bin/date '+%Y-%m-%d %H:%M:%S %z')" >> "$manifest"
print -r -- "" >> "$manifest"
while IFS= read -r -d '' file; do
  [[ "$file" == "$manifest" ]] && continue
  relative="${file#$stage/}"
  digest="$(/usr/bin/shasum -a 256 "$file" | /usr/bin/awk '{print $1}')"
  print -r -- "$digest  $relative" >> "$manifest"
done < <(/usr/bin/find "$stage" -type f -print0 | /usr/bin/sort -z)

/bin/rm -f "$zip_path"
cd "$build_root"
/usr/bin/zip -qry "$zip_path" "$stage_name"

print -r -- "$zip_path"
/usr/bin/du -sh "$zip_path"
