import asyncio
from pathlib import Path

from conf import BASE_DIR
from uploader.douyin_uploader.main import DouYinVideo
from uploader.ks_uploader.main import KSVideo
from uploader.tencent_uploader.main import TencentVideo
from uploader.xiaohongshu_uploader.main import XiaoHongShuVideo
from utils.constant import TencentZoneTypes
from utils.files_times import generate_schedule_time_next_day


def post_absolute_video_draft(
    platform_type,
    *,
    media_path,
    account_file,
    title,
    description="",
    tags=None,
    cover_path=None,
    cover_landscape_path=None,
    short_title=None,
):
    """把工作流已经生成的绝对路径素材安全保存为单平台草稿。"""
    media = Path(media_path).resolve()
    cookie = Path(account_file).resolve()
    if not media.is_file():
        raise FileNotFoundError(f"成品视频不存在：{media}")
    if not cookie.is_file():
        raise FileNotFoundError(f"账号登录文件不存在：{cookie.name}")

    common = {
        "title": title,
        "file_path": str(media),
        "tags": tags or [],
        "publish_date": 0,
        "account_file": cookie,
        "desc": description or "",
    }
    if platform_type == 1:
        app = XiaoHongShuVideo(
            **common,
            thumbnail_path=str(cover_path) if cover_path else None,
        )
        asyncio.run(app.main(), debug=False)
    elif platform_type == 2:
        app = TencentVideo(
            **common,
            is_draft=True,
            thumbnail_portrait_path=str(cover_path) if cover_path else None,
            thumbnail_landscape_path=(
                str(cover_landscape_path) if cover_landscape_path else None
            ),
            short_title=short_title,
        )
        asyncio.run(app.main(), debug=False)
    elif platform_type == 3:
        app = DouYinVideo(
            **common,
            thumbnail_portrait_path=str(cover_path) if cover_path else None,
            thumbnail_landscape_path=(
                str(cover_landscape_path) if cover_landscape_path else None
            ),
        )
        asyncio.run(app.douyin_upload_video(), debug=False)
    elif platform_type == 4:
        app = KSVideo(
            **common,
            thumbnail_path=str(cover_path) if cover_path else None,
        )
        asyncio.run(app.main(), debug=False)
    else:
        raise ValueError(f"不支持的视频草稿平台：{platform_type}")


def post_video_tencent(title,files,tags,account_file,category=TencentZoneTypes.LIFESTYLE.value,enableTimer=False,videos_per_day = 1, daily_times=None,start_days = 0, is_draft=True):
    # 生成文件的完整路径
    account_file = [Path(BASE_DIR / "cookiesFile" / file) for file in account_file]
    files = [Path(BASE_DIR / "videoFile" / file) for file in files]
    if enableTimer:
        publish_datetimes = generate_schedule_time_next_day(len(files), videos_per_day, daily_times,start_days)
    else:
        publish_datetimes = [0 for i in range(len(files))]
    for index, file in enumerate(files):
        for cookie in account_file:
            print(f"文件路径{str(file)}")
            # 打印视频文件名、标题和 hashtag
            print(f"视频文件名：{file}")
            print(f"标题：{title}")
            print(f"Hashtag：{tags}")
            app = TencentVideo(title, str(file), tags, publish_datetimes[index], cookie, category, is_draft)
            asyncio.run(app.main(), debug=False)


def post_video_DouYin(title,files,tags,account_file,category=TencentZoneTypes.LIFESTYLE.value,enableTimer=False,videos_per_day = 1, daily_times=None,start_days = 0,
                      thumbnail_path = '',
                      productLink = '', productTitle = ''):
    # 生成文件的完整路径
    account_file = [Path(BASE_DIR / "cookiesFile" / file) for file in account_file]
    files = [Path(BASE_DIR / "videoFile" / file) for file in files]
    if enableTimer:
        publish_datetimes = generate_schedule_time_next_day(len(files), videos_per_day, daily_times,start_days)
    else:
        publish_datetimes = [0 for i in range(len(files))]
    for index, file in enumerate(files):
        for cookie in account_file:
            print(f"文件路径{str(file)}")
            # 打印视频文件名、标题和 hashtag
            print(f"视频文件名：{file}")
            print(f"标题：{title}")
            print(f"Hashtag：{tags}")
            app = DouYinVideo(title, str(file), tags, publish_datetimes[index], cookie, thumbnail_path, productLink, productTitle)
            asyncio.run(app.douyin_upload_video(), debug=False)


def post_video_ks(title,files,tags,account_file,category=TencentZoneTypes.LIFESTYLE.value,enableTimer=False,videos_per_day = 1, daily_times=None,start_days = 0):
    # 生成文件的完整路径
    account_file = [Path(BASE_DIR / "cookiesFile" / file) for file in account_file]
    files = [Path(BASE_DIR / "videoFile" / file) for file in files]
    if enableTimer:
        publish_datetimes = generate_schedule_time_next_day(len(files), videos_per_day, daily_times,start_days)
    else:
        publish_datetimes = [0 for i in range(len(files))]
    for index, file in enumerate(files):
        for cookie in account_file:
            print(f"文件路径{str(file)}")
            # 打印视频文件名、标题和 hashtag
            print(f"视频文件名：{file}")
            print(f"标题：{title}")
            print(f"Hashtag：{tags}")
            app = KSVideo(title, str(file), tags, publish_datetimes[index], cookie)
            asyncio.run(app.main(), debug=False)

def post_video_xhs(title,files,tags,account_file,category=TencentZoneTypes.LIFESTYLE.value,enableTimer=False,videos_per_day = 1, daily_times=None,start_days = 0):
    # 生成文件的完整路径
    account_file = [Path(BASE_DIR / "cookiesFile" / file) for file in account_file]
    files = [Path(BASE_DIR / "videoFile" / file) for file in files]
    file_num = len(files)
    if enableTimer:
        publish_datetimes = generate_schedule_time_next_day(file_num, videos_per_day, daily_times,start_days)
    else:
        publish_datetimes = 0
    for index, file in enumerate(files):
        for cookie in account_file:
            # 打印视频文件名、标题和 hashtag
            print(f"视频文件名：{file}")
            print(f"标题：{title}")
            print(f"Hashtag：{tags}")
            app = XiaoHongShuVideo(title, file, tags, publish_datetimes, cookie)
            asyncio.run(app.main(), debug=False)



# post_video("333",["demo.mp4"],"d","d")
# post_video_DouYin("333",["demo.mp4"],"d","d")
