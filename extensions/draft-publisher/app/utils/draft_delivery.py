from __future__ import annotations

from dataclasses import dataclass


DRAFT_BUTTON_LABELS = (
    "保存草稿",
    "存草稿",
    "保存到草稿箱",
    "退出并保存",
    # 抖音把草稿按钮叫「暂存离开」（点了存草稿并退出编辑页），语义和上面的
    # 「退出并保存」一样。缺这一条会导致抖音每次都报「没有可用的保存草稿按钮」
    # 而中止 —— 它旁边就是「发布」和「高清发布」，所以中止是对的，
    # 但正确的做法是认得这个按钮，而不是让它发不出去。
    "暂存离开",
)

DRAFT_SUCCESS_TEXTS = (
    "草稿保存成功",
    "保存草稿成功",
    "已保存到草稿箱",
    "已存入草稿箱",
)


class DraftSaveUnavailable(RuntimeError):
    """Raised when the current creator page cannot safely save a draft."""


@dataclass(frozen=True, slots=True)
class DraftSaveResult:
    platform: str
    button_label: str
    previous_url: str
    current_url: str


async def _is_visible(locator) -> bool:
    try:
        return bool(await locator.count()) and bool(await locator.is_visible())
    except Exception:
        return False


async def _is_enabled(locator) -> bool:
    try:
        return bool(await locator.is_enabled())
    except Exception:
        return True


async def _find_draft_button(page):
    for label in DRAFT_BUTTON_LABELS:
        candidates = (
            page.get_by_role("button", name=label, exact=True).first,
            page.locator(f'button:has-text("{label}")').first,
        )
        for candidate in candidates:
            if await _is_visible(candidate) and await _is_enabled(candidate):
                return label, candidate
    return None, None


async def save_draft_only(page, platform: str, timeout_ms: int = 12000) -> DraftSaveResult:
    """Save the prepared work as a draft without ever querying or clicking publish controls."""

    label, draft_button = await _find_draft_button(page)
    if draft_button is None and platform == "小红书":
        # 小红书新版使用无子节点的 Web Component，界面文字来自属性：
        # 左半边 save-text="暂存离开"，右半边 submit-text="发布"。
        # 只有明确读到安全的 save-text 才允许在左侧 25% 处用真实鼠标点击。
        component = page.locator("xhs-publish-btn[save-text]").first
        if await _is_visible(component):
            save_text = str(await component.get_attribute("save-text") or "").strip()
            if any(word in save_text for word in ("暂存", "草稿", "保存")):
                box = await component.bounding_box()
                if box:
                    previous_url = str(getattr(page, "url", "") or "")
                    await page.mouse.move(
                        box["x"] + box["width"] * 0.25,
                        box["y"] + box["height"] * 0.5,
                    )
                    await page.mouse.click(
                        box["x"] + box["width"] * 0.25,
                        box["y"] + box["height"] * 0.5,
                    )
                    await page.wait_for_timeout(1200)
                    current_url = str(getattr(page, "url", "") or "")
                    if current_url != previous_url or not await _is_visible(component):
                        return DraftSaveResult(
                            platform, save_text, previous_url, current_url
                        )
                    for success_text in DRAFT_SUCCESS_TEXTS:
                        if await _is_visible(
                            page.get_by_text(success_text, exact=False).first
                        ):
                            return DraftSaveResult(
                                platform, save_text, previous_url, current_url
                            )
                    raise DraftSaveUnavailable(
                        "小红书已点击明确标注“暂存离开”的左侧区域，但未能确认草稿保存；"
                        "已停止，未点击右侧发布。"
                    )
    if draft_button is None:
        visible_buttons = []
        try:
            visible_buttons = [
                " ".join(text.split())[:40]
                for text in await page.locator("button:visible").all_inner_texts()
                if " ".join(text.split())
            ][:12]
        except Exception:
            pass
        diagnostic = f"；当前可见按钮：{'、'.join(visible_buttons)}" if visible_buttons else ""
        raise DraftSaveUnavailable(
            f"{platform} 当前页面没有可用的“保存草稿”按钮；已停止，未点击发布{diagnostic}"
        )

    previous_url = str(getattr(page, "url", "") or "")
    await draft_button.click()

    try:
        await page.wait_for_timeout(500)
    except Exception:
        pass

    current_url = str(getattr(page, "url", "") or "")
    if current_url != previous_url or "draft" in current_url.lower():
        return DraftSaveResult(platform, label, previous_url, current_url)

    for success_text in DRAFT_SUCCESS_TEXTS:
        success_marker = page.get_by_text(success_text, exact=False).first
        if await _is_visible(success_marker):
            return DraftSaveResult(platform, label, previous_url, current_url)

    try:
        await draft_button.wait_for(state="hidden", timeout=timeout_ms)
        return DraftSaveResult(
            platform,
            label,
            previous_url,
            str(getattr(page, "url", "") or ""),
        )
    except Exception as exc:
        raise DraftSaveUnavailable(
            f"{platform} 已点击“{label}”，但未能确认草稿保存成功；请到草稿箱人工核验。"
        ) from exc
