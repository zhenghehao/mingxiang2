#!/usr/bin/env python3
"""
把主标题和副标题精确叠到封面照片左侧。

为什么要有这个脚本：让图片模型自己渲染中文，实测错误率不低 —— 副标题被写成主标题的
重复、把提示词里的引号画进图里、把"四个字"这种说明也画进去。加了读图校验 + 三轮重试
之后命中率到 7/8，但仍有漏网的，而且**字号完全不可控**，模型爱画多大画多大。

本地叠字把这两件事一次解决：文字 100% 准确，字号、位置、字距、行距全部可控。
代价是文字不再"长在画面里"（没有被光晕影响的融合感），换来的是稳定。

用法：
  python3 compose_cover_text.py 照片.png --subtitle "雪压竹枝的深夜微光" --output 成品.png
  可选：--font songti|heiti --title-ratio 0.108 --subtitle-ratio 0.052 --scrim 0.46
"""

import argparse
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("需要 Pillow：python3 -m pip install pillow")

# 字族 → (路径, 主标题 ttc index, 副标题 ttc index)
#
# ttc 是字体集合，一个文件里塞了多个字重，要用 index 选。Songti.ttc 里的简体字重是：
#   0 SC Black / 1 SC Bold / 3 SC Light / 6 SC Regular（2、5、7 是繁体 TC）
# 主标题取 Bold、副标题取 Regular —— 层次靠字重拉开，不必把主标题撑得过大。
# 宋体的横细竖粗在深色底上比黑体更容易发虚，所以副标题不用 Light。
# macOS 在前、Linux 在后。CI 跑在 ubuntu-latest 上，那边没有 Songti，
# 装 fonts-noto-cjk 后会有 Noto Serif/Sans CJK —— 宋体对应 Serif、黑体对应 Sans。
# 顺序即优先级，找不到就往下试，一个都没有才报错。
FONT_FAMILIES = {
    "songti": [
        ("/System/Library/Fonts/Supplemental/Songti.ttc", 1, 6),
        ("/System/Library/Fonts/Supplemental/Songti.ttc", 0, 4),
        ("/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc", 2, 2),
        ("/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc", 2, 2),
        ("/usr/share/fonts/truetype/noto/NotoSerifCJK-Bold.ttc", 2, 2),
    ],
    "heiti": [
        ("/System/Library/Fonts/Hiragino Sans GB.ttc", 1, 0),
        ("/System/Library/Fonts/STHeiti Medium.ttc", 0, 0),
        ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0, 0),
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 2, 2),
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 2, 2),
    ],
}


def load_fonts(title_px, subtitle_px, family):
    """
    返回 (主标题字体, 副标题字体, 用了哪个文件)。

    第三个返回值是给日志用的。在 CI 上「没报错」不等于「字体对」——
    ttc 里的 index 是猜的，猜错可能拿到日文或韩文字形的 CJK 变体，
    中文照样能渲染但字形别扭。把实际用到的文件和 index 打出来，
    出问题时一眼能看到是哪个，而不是对着一张怪图猜。
    """
    last = None
    # 指定的字族排在前面，其余作为兜底 —— 换机器时字体可能不全，
    # 宁可换个字体出图，也不要因为缺字体让整张封面失败。
    order = FONT_FAMILIES.get(family, []) + [
        item for key, group in FONT_FAMILIES.items() if key != family for item in group
    ]
    for path, bold_idx, light_idx in order:
        for indices in ((bold_idx, light_idx), (0, 0)):
            try:
                title = ImageFont.truetype(path, title_px, index=indices[0])
                sub = ImageFont.truetype(path, subtitle_px, index=indices[1])
                name = "/".join(filter(None, title.getname()))
                return title, sub, f"{os.path.basename(path)}[{indices[0]},{indices[1]}] {name}"
            except Exception as exc:  # 字体缺失或 index 越界，换下一个
                last = exc
    sys.exit(f"找不到可用的中文字体：{last}")


def build_scrim(width, height, ratio, strength):
    """
    左侧压暗层。

    不用硬边框（drawbox 那种）——那会在画面中间留一道生硬的竖线，
    之前模型自己画的封面就有这个毛病。这里做一条水平方向的 alpha 渐变，
    左端最暗、到 ratio 处完全透明，让文字区和照片自然过渡。
    """
    scrim = Image.new("L", (width, 1))
    edge = max(1, int(width * ratio))
    px = scrim.load()
    for x in range(width):
        if x >= edge:
            px[x, 0] = 0
        else:
            # 二次曲线收尾，比线性更柔和
            t = 1.0 - (x / edge)
            px[x, 0] = int(255 * strength * (t ** 1.6))
    return scrim.resize((width, height))


def draw_text_block(image, title, subtitle, opts):
    width, height = image.size
    title_px = max(24, int(height * opts.title_ratio))
    subtitle_px = max(16, int(height * opts.subtitle_ratio))
    title_font, subtitle_font, font_used = load_fonts(title_px, subtitle_px, opts.font)
    opts._font_used = font_used

    # 左侧压暗，保证浅色字在任何照片上都读得清
    if opts.scrim > 0:
        alpha = build_scrim(width, height, opts.scrim, opts.scrim_strength)
        shade = Image.new("RGB", (width, height), (8, 12, 24))
        image = Image.alpha_composite(
            image.convert("RGBA"),
            Image.merge("RGBA", (*shade.split(), alpha)),
        ).convert("RGB")

    draw = ImageDraw.Draw(image)
    left = int(width * opts.left_ratio)

    def line_height(font, text):
        box = draw.textbbox((0, 0), text, font=font)
        return box[3] - box[1], box[1]

    title_h, title_off = line_height(title_font, title)
    sub_h, sub_off = line_height(subtitle_font, subtitle) if subtitle else (0, 0)
    gap = int(title_px * opts.gap_ratio)
    total = title_h + (gap + sub_h if subtitle else 0)
    top = int((height - total) * opts.vertical_ratio)

    # 主标题：加一层极淡的阴影，避免落在亮处时糊掉
    if opts.shadow:
        draw.text((left + 2, top - title_off + 3), title, font=title_font, fill=(0, 0, 0, 120))
    draw.text((left, top - title_off), title, font=title_font, fill=opts.title_color)

    if subtitle:
        sub_top = top + title_h + gap
        if opts.shadow:
            draw.text((left + 1, sub_top - sub_off + 2), subtitle, font=subtitle_font, fill=(0, 0, 0, 110))
        draw.text((left, sub_top - sub_off), subtitle, font=subtitle_font, fill=opts.subtitle_color)

    return image


def parse_color(value):
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("photo")
    ap.add_argument("--title", default="睡前冥想")
    ap.add_argument("--subtitle", default="")
    ap.add_argument("--output", "-o", required=True)
    # 字号按图高的比例算，不写死像素 —— 4:3 和 16:9 两种尺寸要看起来一致。
    # 模型自己渲染时字号完全不可控（实测大得离谱）。0.108 约等于图高的 11%。
    ap.add_argument("--title-ratio", type=float, default=0.108)
    ap.add_argument("--subtitle-ratio", type=float, default=0.052)
    ap.add_argument("--font", choices=sorted(FONT_FAMILIES), default="songti",
                    help="字族：songti 宋体（默认）/ heiti 黑体")
    ap.add_argument("--gap-ratio", type=float, default=0.42, help="主副标题间距，相对主标题字号")
    ap.add_argument("--left-ratio", type=float, default=0.058, help="左边距占图宽比例")
    ap.add_argument("--vertical-ratio", type=float, default=0.44, help="文字块垂直位置，0 顶 1 底")
    ap.add_argument("--scrim", type=float, default=0.46, help="左侧压暗宽度占图宽比例，0 关闭")
    ap.add_argument("--scrim-strength", type=float, default=0.78)
    ap.add_argument("--title-color", type=parse_color, default=(255, 253, 248))
    ap.add_argument("--subtitle-color", type=parse_color, default=(219, 216, 205))
    ap.add_argument("--no-shadow", dest="shadow", action="store_false")
    opts = ap.parse_args()

    image = Image.open(opts.photo).convert("RGB")
    result = draw_text_block(image, opts.title, opts.subtitle, opts)
    result.save(opts.output, "PNG")
    print(f"{opts.output}  {result.size[0]}x{result.size[1]}  "
          f"主标题 {int(result.size[1] * opts.title_ratio)}px  副标题 {int(result.size[1] * opts.subtitle_ratio)}px  "
          f"字体 {getattr(opts, '_font_used', opts.font)}")


if __name__ == "__main__":
    main()
