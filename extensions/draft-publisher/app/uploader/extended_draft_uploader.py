"""Draft adapters reused from the calibrated meditation publisher.

The source project at ``~/Desktop/最终发布`` has live-tested selectors for
Bilibili, Ximalaya and NetEase Podcast.

视频平台（B站等）在这里**只存草稿，永不发布**，和这个分支最初的约定一致。

音频平台（喜马拉雅、网易云播客）是例外：用户 2026-07-26 明确要求「音频直接发布，
视频放草稿箱」，所以这两个适配器支持 ``publish=True``，会去点最终的
「确认发布」/「提 交」。默认仍然是 False —— 要发布必须由调用方显式传进来，
不会因为改了别处的默认值就悄悄开始对外发内容。

点完必须**验证真的发出去了**。这条流水线在旧工具上吃过亏：表单校验没过时页面
原地不动，代码却把「点过按钮」记成成功，结果作品根本没发出去。所以下面每个
publish 分支都以「页面跳转 / 出现成功提示 / 能在列表里找到标题」为准。
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path

from patchright.sync_api import sync_playwright

from conf import BASE_DIR


class ExtendedDraftError(RuntimeError):
    """Raised when a safe draft/preparation operation cannot be confirmed."""


@dataclass
class DraftOutcome:
    platform: str
    state: str
    title: str
    message: str
    record_path: str = ""


def _record_outcome(outcome: DraftOutcome, media_path: Path) -> DraftOutcome:
    queue_dir = Path(BASE_DIR) / "draftQueue"
    queue_dir.mkdir(exist_ok=True)
    record = {
        **asdict(outcome),
        "media_path": str(media_path),
        "created_at": int(time.time()),
    }
    target = queue_dir / f"{int(time.time())}-{uuid.uuid4().hex[:8]}.json"
    target.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    outcome.record_path = str(target)
    target.write_text(
        json.dumps({**record, "record_path": outcome.record_path}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return outcome


class ExistingChrome:
    """Connect to the user's explicitly started, already-signed-in Chrome."""

    port = int(os.environ.get("DRAFT_CDP_PORT", "9222"))

    @classmethod
    def connect(cls, playwright):
        try:
            browser = playwright.chromium.connect_over_cdp(
                f"http://127.0.0.1:{cls.port}"
            )
        except Exception as exc:
            raise ExtendedDraftError(
                f"无法连接草稿浏览器（端口 {cls.port}）。请先运行 run_draft_browser.sh，"
                "并在打开的 Chrome 中完成平台登录。"
            ) from exc
        if not browser.contexts:
            raise ExtendedDraftError("草稿浏览器没有可用的登录上下文")
        return browser, browser.contexts[0]

    @staticmethod
    def upload_local_path(page, selector: str, file_path: Path, *, index: int = 0):
        locator = page.locator(selector).nth(index)
        locator.wait_for(state="attached", timeout=30_000)
        session = page.context.new_cdp_session(page)
        try:
            document = session.send("DOM.getDocument", {"depth": -1, "pierce": True})
            result = session.send(
                "DOM.querySelectorAll",
                {"nodeId": document["root"]["nodeId"], "selector": selector},
            )
            node_ids = result.get("nodeIds") or []
            if index >= len(node_ids):
                raise ExtendedDraftError(f"页面中找不到上传控件：{selector}")
            session.send(
                "DOM.setFileInputFiles",
                {"nodeId": node_ids[index], "files": [str(file_path)]},
            )
        finally:
            session.detach()


class BilibiliDraftAdapter:
    platform = "bilibili"
    upload_url = "https://member.bilibili.com/platform/upload/video/frame"
    draft_url = (
        "https://member.bilibili.com/platform/upload-manager/article?"
        "group=draft&page=1"
    )
    cover_4x3 = Path.home() / "Desktop" / "bilibili" / "4比3.png"
    cover_16x9 = Path.home() / "Desktop" / "bilibili" / "16比9.png"
    cover_input = 'input[type=file][accept="image/png, image/jpeg"]'
    partition = "健康"

    @classmethod
    def _select_partition(cls, page):
        controller = page.locator(".video-human-type .select-controller").first
        controller.wait_for(state="visible", timeout=20_000)
        if cls.partition in (controller.inner_text() or ""):
            return
        for _ in range(2):
            controller.click()
            page.wait_for_timeout(1500)
            if page.locator(".drop-list-v2-item:visible p.item-cont-main").count():
                break
        option = page.locator(
            f'.drop-list-v2-item:visible:has(p.item-cont-main:text-is("{cls.partition}"))'
        ).first
        option.wait_for(state="visible", timeout=10_000)
        option.click()
        page.wait_for_timeout(1000)
        if cls.partition not in (controller.inner_text() or ""):
            raise ExtendedDraftError("B站分区“健康”选择后读回校验失败")

    @classmethod
    def _upload_covers(cls, page):
        for cover in (cls.cover_4x3, cls.cover_16x9):
            if not cover.is_file():
                raise ExtendedDraftError(f"B站封面不存在：{cover}")

        edit_button = page.locator('span.edit-text:has-text("封面设置")').first
        edit_button.wait_for(state="visible", timeout=20_000)
        edit_button.click()
        page.wait_for_timeout(1500)

        ExistingChrome.upload_local_path(page, cls.cover_input, cls.cover_4x3)
        page.wait_for_timeout(3000)

        personal_tab = page.get_by_text("个人空间封面").first
        personal_tab.wait_for(state="visible", timeout=10_000)
        personal_tab.click()
        page.wait_for_timeout(1500)
        input_count = page.locator(cls.cover_input).count()
        ExistingChrome.upload_local_path(
            page,
            cls.cover_input,
            cls.cover_16x9,
            index=1 if input_count > 1 else 0,
        )
        page.wait_for_timeout(3000)

        # 图片处理完成前，页面可能先渲染一个隐藏的“完成”；只点击当前可见项。
        clicked = False
        for _ in range(60):
            finish = page.get_by_text("完成", exact=True)
            for index in range(finish.count()):
                candidate = finish.nth(index)
                if candidate.is_visible():
                    candidate.click(timeout=10_000)
                    clicked = True
                    break
            if clicked:
                break
            page.wait_for_timeout(1000)
        if not clicked:
            raise ExtendedDraftError("B站封面处理超时，找不到可见的“完成”按钮")
        personal_tab.wait_for(state="hidden", timeout=10_000)

    @staticmethod
    def _select_ai_declaration(page):
        declaration = page.locator(
            'input[placeholder="请选择符合您视频内容的创作声明"]'
        )
        declaration.wait_for(state="visible", timeout=10_000)
        declaration.click()
        option = page.locator('li.bcc-option:has-text("含AI生成内容")').first
        option.wait_for(state="visible", timeout=8_000)
        option.click()
        page.wait_for_timeout(500)

    @classmethod
    def _verify_saved_details(cls, page, title: str, description: str):
        page.goto(cls.draft_url, wait_until="domcontentloaded", timeout=40_000)
        page.wait_for_timeout(5000)
        title_link = page.get_by_text(title[:20], exact=False).first
        if not title_link.count():
            raise ExtendedDraftError(
                f"B站草稿箱没有找到“{title[:20]}”"
            )
        edit_url = title_link.evaluate(
            'element => element.closest("a")?.href || ""'
        )
        if not edit_url:
            raise ExtendedDraftError("B站草稿存在，但无法打开草稿详情核验")

        page.goto(edit_url, wait_until="domcontentloaded", timeout=40_000)
        title_box = page.locator('input[placeholder="请输入稿件标题"]')
        title_box.wait_for(timeout=30_000)
        page.wait_for_timeout(2500)

        if description:
            saved_description = page.locator("div.ql-editor").first.inner_text()
            if description[:20] not in saved_description:
                raise ExtendedDraftError("B站草稿重新打开后简介内容不一致")

        declaration = page.locator(
            'input[placeholder="请选择符合您视频内容的创作声明"]'
        ).input_value()
        if "含AI生成内容" not in declaration:
            raise ExtendedDraftError("B站草稿重新打开后缺少“含AI生成内容”声明")

        # B站新版“健康”属于 human_type2。当前站点的存草稿接口不会保存
        # 这个字段（正式发布接口才会携带），因此保存后重新打开并选好健康，
        # 把编辑页留给用户最终检查和手动发布。这里绝不能再次点“存草稿”。
        cls._select_partition(page)
        current = (
            page.locator(".video-human-type .select-controller").first.inner_text()
            or ""
        ).strip()
        if cls.partition not in current:
            raise ExtendedDraftError("B站草稿编辑页未能预选“健康”分区")

    def save(
        self,
        media_path: Path,
        title: str,
        tags: list[str],
        description: str = "",
    ) -> DraftOutcome:
        with sync_playwright() as playwright:
            _, context = ExistingChrome.connect(playwright)
            page = context.new_page()
            page.goto(self.upload_url, wait_until="domcontentloaded", timeout=40_000)
            page.wait_for_timeout(4000)
            ExistingChrome.upload_local_path(
                page, 'input[type=file][accept*=".mp4"]', media_path
            )
            title_box = page.locator('input[placeholder="请输入稿件标题"]')
            title_box.wait_for(timeout=180_000)
            title_box.fill(title[:80])

            if description:
                editor = page.locator("div.ql-editor").first
                editor.wait_for(state="visible", timeout=15_000)
                editor.click()
                page.keyboard.type(description)
                page.wait_for_timeout(500)

            tag_input = page.locator(
                'input[placeholder="按回车键Enter创建标签"]'
            ).first
            for tag in (tags or [])[:10]:
                tag_input.fill(str(tag))
                tag_input.press("Enter")

            # 复用冥想工作流已真机校准的分区、双尺寸封面和 AI 声明流程。
            self._select_partition(page)
            self._upload_covers(page)
            self._select_ai_declaration(page)
            # 封面弹窗关闭或页面重渲染后，B站可能把自动推荐分区覆盖回来。
            # 存草稿前最后再选一次；保存后还会重新打开并预选健康。
            self._select_partition(page)

            draft_button = page.locator("span.submit-draft").first
            draft_button.wait_for(state="visible", timeout=30_000)
            draft_button.click()
            page.wait_for_timeout(3000)

            self._verify_saved_details(page, title, description)
            return _record_outcome(
                DraftOutcome(
                    platform=self.platform,
                    state="draft_saved",
                    title=title,
                    message=(
                        "B站草稿已保存并核验；“健康”已在打开的编辑页预选，"
                        "请勿刷新或关闭该页，检查后手动发布"
                    ),
                ),
                media_path,
            )


class XimalayaPreparedAdapter:
    platform = "ximalaya"
    upload_url = "https://studio.ximalaya.com/upload"
    iframe_selector = "iframe[src*='reform-upload']"

    def prepare(
        self, media_path: Path, title: str, description: str = "", publish: bool = False
    ) -> DraftOutcome:
        with sync_playwright() as playwright:
            _, context = ExistingChrome.connect(playwright)
            page = context.new_page()
            page.goto(self.upload_url, wait_until="domcontentloaded", timeout=40_000)
            page.wait_for_timeout(5000)
            if "passport.ximalaya.com" in page.url or "/login" in page.url:
                raise ExtendedDraftError("喜马拉雅尚未登录")

            frame = page.frame_locator(self.iframe_selector)
            frame.locator("input[type=file]").set_input_files(str(media_path))
            title_box = frame.locator("input[placeholder='请输入声音标题']")
            title_box.wait_for(timeout=180_000)
            title_box.fill(title[:40])
            if description:
                recommendation = frame.locator("textarea[placeholder*='推荐语']")
                for index in range(recommendation.count()):
                    candidate = recommendation.nth(index)
                    if candidate.is_visible():
                        candidate.fill(description[:200])
                        break

            formal_button = frame.get_by_role("button", name="确认发布")
            formal_button.wait_for(state="visible", timeout=30_000)

            if not publish:
                # 安全模式：“确认发布”只用于确认表单已经进入可人工检查状态，绝不点击。
                return _record_outcome(
                    DraftOutcome(
                        platform=self.platform,
                        state="prepared_for_manual_review",
                        title=title,
                        message="喜马拉雅表单已填写，未点击确认发布；请在浏览器中人工检查",
                    ),
                    media_path,
                )

            previous_url = page.url
            formal_button.click()
            page.wait_for_timeout(5000)
            # 发成功后喜马拉雅会跳到声音管理页。停在原地通常是表单校验没过，
            # 那种情况下绝不能报成功 —— 旧工具就是这么产生假成功的。
            for _ in range(20):
                body = page.inner_text("body")
                if page.url != previous_url or "声音管理" in body or "发布成功" in body:
                    return _record_outcome(
                        DraftOutcome(
                            platform=self.platform,
                            state="published",
                            title=title,
                            message="喜马拉雅已发布（页面已跳转/出现成功提示）",
                        ),
                        media_path,
                    )
                page.wait_for_timeout(1500)
            raise ExtendedDraftError(
                "喜马拉雅点击「确认发布」后没有跳转到声音管理页，发布未成功；"
                "请在浏览器里检查表单校验提示"
            )


class NeteasePreparedAdapter:
    platform = "netease"
    upload_url = "https://music.163.com/st/ncreator/upload?userType=3"

    def prepare(
        self, media_path: Path, title: str, description: str = "", publish: bool = False
    ) -> DraftOutcome:
        with sync_playwright() as playwright:
            _, context = ExistingChrome.connect(playwright)
            page = context.new_page()
            page.goto(self.upload_url, wait_until="domcontentloaded", timeout=40_000)
            page.wait_for_timeout(5000)
            if "点击登录" in page.inner_text("body"):
                raise ExtendedDraftError("网易云音乐尚未登录")

            ExistingChrome.upload_local_path(page, "input[type=file]", media_path)
            name_box = page.locator('input[name="name"]')
            name_box.wait_for(timeout=300_000)
            for _ in range(150):
                if "上传成功" in page.inner_text("body"):
                    break
                page.wait_for_timeout(2000)
            else:
                raise ExtendedDraftError("网易云音频上传超时")

            name_box.fill(title[:40])
            if description:
                editor = page.locator("div.ql-editor").first
                if editor.count():
                    editor.fill(description)

            # 冥想工作流的人声由 AI 合成，因此如页面提供声明则明确选“是”。
            ai_radio = page.locator('input[name="aiGenerated"][value="true"]')
            if ai_radio.count() and not ai_radio.first.is_checked():
                ai_radio.first.click(force=True)

            formal_button = page.get_by_text(re.compile(r"^\s*提\s*交\s*$"))
            if not formal_button.count():
                raise ExtendedDraftError("网易云表单未进入可人工检查状态")

            if not publish:
                # 安全模式：“提 交”只用于确认表单完整，绝不点击。
                return _record_outcome(
                    DraftOutcome(
                        platform=self.platform,
                        state="prepared_for_manual_review",
                        title=title,
                        message="网易云播客表单已填写，未点击提交；请在浏览器中人工检查",
                    ),
                    media_path,
                )

            previous_url = page.url
            formal_button.first.click()
            page.wait_for_timeout(5000)
            # 网易云点「提交」后可能还有一层确认框
            for confirm_text in ("确定", "确认", "立即发布"):
                try:
                    confirm = page.get_by_role("button", name=confirm_text, exact=True).first
                    if confirm.count() and confirm.is_visible():
                        confirm.click(timeout=4000)
                        page.wait_for_timeout(3000)
                        break
                except Exception:
                    continue
            # 以「作品列表里能找到这条单集」为准。旧工具在这里踩过坑：
            # 点完提交页面没动，却被记成 success，实际什么都没发出去。
            for _ in range(20):
                body = page.inner_text("body")
                if page.url != previous_url or "发布成功" in body or "提交成功" in body:
                    return _record_outcome(
                        DraftOutcome(
                            platform=self.platform,
                            state="published",
                            title=title,
                            message="网易云播客已发布（页面已跳转/出现成功提示）",
                        ),
                        media_path,
                    )
                page.wait_for_timeout(1500)
            raise ExtendedDraftError(
                "网易云点击「提交」后页面没有变化，发布未成功；"
                "请在浏览器里检查表单校验提示"
            )


def process_extended_draft(
    platform_type: int,
    files: list[str],
    title: str,
    tags=None,
    description: str = "",
    publish: bool = False,
):
    """publish=True 只对音频平台（6 喜马拉雅 / 7 网易云）生效。

    B站（5）永远走存草稿，不受这个参数影响 —— 视频一律进草稿箱是这个分支的约定。
    """
    paths = [Path(BASE_DIR) / "videoFile" / Path(item).name for item in files]
    for media_path in paths:
        if not media_path.is_file():
            raise ExtendedDraftError(f"素材不存在：{media_path.name}")

    outcomes = []
    for media_path in paths:
        if platform_type == 5:
            outcome = BilibiliDraftAdapter().save(
                media_path, title, tags or [], description
            )
        elif platform_type == 6:
            outcome = XimalayaPreparedAdapter().prepare(
                media_path, title, description or " ".join(tags or []), publish=publish
            )
        elif platform_type == 7:
            outcome = NeteasePreparedAdapter().prepare(
                media_path, title, description or " ".join(tags or []), publish=publish
            )
        else:
            raise ExtendedDraftError(f"未知扩展平台：{platform_type}")
        outcomes.append(asdict(outcome))
    return outcomes
