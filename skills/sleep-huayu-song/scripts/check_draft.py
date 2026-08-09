#!/usr/bin/env python3
"""Quantitative checks for Chinese sleep-script drafts."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


RATE = 48.7
BANNED = [
    "尸体", "坠落", "坠入", "深渊", "窒息", "溺水", "恐惧", "恐怖",
    "噩梦", "快点", "马上", "赶紧", "你应该", "你必须", "请想象",
    "请随我", "因此", "然而", "综上", "治疗", "治愈", "科学证明",
]
WAKE_WORDS = ["睁开眼睛", "恢复活力", "苏醒", "元气", "清醒", "活动手指"]
PERMIT_WORDS = ["也没有关系", "没有关系", "不需要", "允许", "也可以", "不用"]
SOFT_WORDS = ["轻轻", "慢慢", "缓缓", "静静", "悄悄", "微微", "渐渐"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", help="UTF-8 draft file")
    parser.add_argument("--text", help="Draft text supplied directly")
    parser.add_argument(
        "--target-min",
        choices=["10", "15", "20", "30", "45", "60", "90", "natural"],
        default="20",
        help="Target finished duration or natural",
    )
    parser.add_argument("--mode", choices=["full", "scene", "accept"], default="full")
    parser.add_argument("--wake", action="store_true", help="Expect a wake-up ending")
    parser.add_argument("--pipeline", choices=["extreme", "v3", "base"], default="extreme")
    return parser.parse_args()


def load_text(args: argparse.Namespace) -> str:
    if args.text is not None:
        return args.text
    if not args.path:
        raise SystemExit("Provide a draft path or --text.")
    return Path(args.path).read_text(encoding="utf-8")


def main() -> int:
    args = parse_args()
    text = load_text(args)
    body = re.sub(r"<#[\d.]+#>", "", text)
    plain = re.sub(r"[^\u3400-\u9fff]", "", body)
    chars = len(plain)
    sentences = [s.strip() for s in re.split(r"[。？！…\n]+", body) if s.strip()]
    lengths = [len(re.sub(r"\s+", "", s)) for s in sentences]
    issues: list[str] = []

    target = 20 if args.target_min == "natural" else int(args.target_min)
    speech_target = min(target, 30)
    if args.pipeline == "extreme":
        base = RATE * speech_target + 47
        if args.mode == "scene":
            lo, hi = int(base * 0.60), int(base * 0.70)
        else:
            lo, hi = int(base * 0.95), int(base * 1.05)
        if not lo <= chars <= hi:
            issues.append(f"中文字数 {chars}，目标 {lo}–{hi}")
        print(f"中文字数：{chars}；目标：{lo}–{hi}")
    else:
        print(f"中文字数：{chars}；{args.pipeline} 尚无通用校准，需试音")

    if lengths:
        q = max(len(lengths) // 4, 1)
        head = sum(lengths[:q]) / q
        tail = sum(lengths[-q:]) / q
        longest = max(lengths)
        print(f"句长：开篇 {head:.1f} → 结尾 {tail:.1f}；最长 {longest}")
        if longest > 25:
            issues.append(f"最长单句 {longest} 字，超过 25")
        if head <= tail:
            issues.append("句长没有递减")

    hits = [word for word in BANNED if word in body]
    if hits:
        issues.append("禁用词命中：" + "、".join(hits))
    print("禁用词：" + ("无" if not hits else "、".join(hits)))

    permit = sum(body.count(word) for word in PERMIT_WORDS)
    need = 8 if args.mode == "accept" else 3
    print(f"许可表达：{permit}；要求 ≥{need}")
    if permit < need:
        issues.append(f"许可表达 {permit}，少于 {need}")

    soft = sum(body.count(word) for word in SOFT_WORDS)
    soft_need = max(chars // 200, 1)
    print(f"软化词：{soft}；最低参考 {soft_need}")
    if soft < soft_need:
        issues.append(f"软化词 {soft}，少于参考值 {soft_need}")

    if chars >= 400:
        tail_you = plain[-200:].count("你")
        print(f"最后 200 字含“你”：{tail_you}")
        if tail_you:
            issues.append(f"最后 200 字仍有“你” {tail_you} 次")

    tail_text = body[int(len(body) * 0.85):]
    wake_hits = [word for word in WAKE_WORDS if word in tail_text]
    print("结尾唤醒词：" + ("无" if not wake_hits else "、".join(wake_hits)))
    if args.wake and not wake_hits:
        issues.append("午休版结尾缺少唤醒内容")
    if not args.wake and wake_hits:
        issues.append("夜间版结尾出现唤醒内容")

    if target > 30 and "［接续］" not in text:
        issues.append("30 分钟以上成品缺少［接续］说明")

    if issues:
        print("\n需要复核：")
        for issue in issues:
            print(f"- {issue}")
        return 1

    print("\n量化检查通过；仍需人工复核题材专属结构。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
