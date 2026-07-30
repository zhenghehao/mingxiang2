import asyncio
import json
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from queue import Queue
from urllib.request import urlopen
from flask_cors import CORS
from flask import Flask, request, jsonify, Response, render_template, send_from_directory
from werkzeug.utils import secure_filename
from conf import BASE_DIR
from myUtils.login import get_tencent_cookie, douyin_cookie_gen, get_ks_cookie, xiaohongshu_cookie_gen
from myUtils.postVideo import (
    post_absolute_video_draft,
    post_video_tencent,
    post_video_DouYin,
    post_video_ks,
    post_video_xhs,
)
from uploader.extended_draft_uploader import (
    BilibiliDraftAdapter,
    NeteasePreparedAdapter,
    XimalayaPreparedAdapter,
    process_extended_draft,
)

active_queues = {}
app = Flask(__name__)

FIXED_BROWSER_ACCOUNTS = {
    5: ("哔哩哔哩", "https://member.bilibili.com/"),
    6: ("喜马拉雅", "https://studio.ximalaya.com/"),
    7: ("网易云播客", "https://music.163.com/st/ncreator/"),
}


def fixed_browser_account_status(platform_type):
    """用固定 Chrome 中已打开的创作中心页面判断扩展平台是否可用。"""
    platform = FIXED_BROWSER_ACCOUNTS.get(platform_type)
    if not platform:
        return 0
    _, expected_url = platform
    try:
        with urlopen("http://127.0.0.1:9222/json/list", timeout=2) as response:
            pages = json.load(response)
        return int(any(expected_url in page.get("url", "") for page in pages))
    except Exception:
        return 0

#允许所有来源跨域访问
CORS(app)

# 限制上传文件大小为160MB
app.config['MAX_CONTENT_LENGTH'] = 160 * 1024 * 1024

PLATFORM_NAMES = {
    1: "小红书",
    2: "视频号",
    3: "抖音",
    4: "快手",
    5: "哔哩哔哩",
    6: "喜马拉雅",
    7: "网易云播客",
}


def _existing_file(value, label):
    file_path = Path(str(value or "")).expanduser().resolve()
    if not file_path.is_file():
        raise ValueError(f"{label}不存在：{file_path}")
    return file_path


def _cookie_file(value):
    requested = Path(str(value or "")).name
    cookie_root = (Path(BASE_DIR) / "cookiesFile").resolve()
    cookie_path = (cookie_root / requested).resolve()
    if not cookie_path.is_relative_to(cookie_root) or not cookie_path.is_file():
        raise ValueError("账号登录文件不存在，请先重新登录")
    return cookie_path


@app.route('/draftAbsolute', methods=['POST'])
def save_absolute_draft():
    """接收工作流成品绝对路径，只执行草稿或人工确认前准备。"""
    data = request.get_json() or {}
    platform_type = int(data.get("type") or 0)
    if platform_type not in PLATFORM_NAMES:
        return jsonify({"code": 400, "msg": "不支持的平台", "data": None}), 400

    try:
        media_path = _existing_file(data.get("mediaPath"), "成品媒体")
        title = str(data.get("title") or "").strip()
        if not title:
            raise ValueError("标题不能为空")
        description = str(data.get("description") or "").strip()
        tags = [str(tag).lstrip("#").strip() for tag in data.get("tags", [])]
        tags = [tag for tag in tags if tag]
        cover_path = (
            _existing_file(data.get("coverPath"), "竖版封面")
            if data.get("coverPath") else None
        )
        cover_landscape_path = (
            _existing_file(data.get("coverLandscapePath"), "横版封面")
            if data.get("coverLandscapePath") else None
        )

        if platform_type in (1, 2, 3, 4):
            account_file = _cookie_file(data.get("accountFile"))
            post_absolute_video_draft(
                platform_type,
                media_path=media_path,
                account_file=account_file,
                title=title,
                description=description,
                tags=tags,
                cover_path=cover_path,
                cover_landscape_path=cover_landscape_path,
                short_title=str(data.get("shortTitle") or "").strip() or None,
            )
            state = "draft_saved"
            message = f"{PLATFORM_NAMES[platform_type]}草稿已保存，未发布"
        elif platform_type == 5:
            if not cover_path or not cover_landscape_path:
                raise ValueError("B站需要4:3和16:9两张封面")
            original_4x3 = BilibiliDraftAdapter.cover_4x3
            original_16x9 = BilibiliDraftAdapter.cover_16x9
            try:
                BilibiliDraftAdapter.cover_4x3 = cover_path
                BilibiliDraftAdapter.cover_16x9 = cover_landscape_path
                outcome = BilibiliDraftAdapter().save(
                    media_path, title, tags, description
                )
            finally:
                BilibiliDraftAdapter.cover_4x3 = original_4x3
                BilibiliDraftAdapter.cover_16x9 = original_16x9
            state = outcome.state
            message = outcome.message
        else:
            # 音频平台（6 喜马拉雅 / 7 网易云）可以直接发布 —— 用户 2026-07-26 的要求：
            # 「音频直接发布，视频放草稿箱」。必须由调用方显式传 publish=true，
            # 缺省仍然停在人工确认前：对外发内容不可撤销，不能靠默认值决定。
            publish = bool(data.get("publish"))
            adapter = (
                XimalayaPreparedAdapter() if platform_type == 6 else NeteasePreparedAdapter()
            )
            outcome = adapter.prepare(
                media_path, title, description or " ".join(tags), publish=publish
            )
            state = outcome.state
            message = outcome.message

        return jsonify({
            "code": 200,
            "msg": message,
            "data": {
                "platform": PLATFORM_NAMES[platform_type],
                "state": state,
                "title": title,
                "message": message,
            },
        }), 200
    except Exception as error:
        message = str(error)
        status = 401 if any(word in message for word in ("登录", "cookie", "Cookie")) else 500
        return jsonify({"code": status, "msg": message, "data": None}), status


@app.route('/draftRuntimeStatus', methods=['GET'])
def draft_runtime_status():
    with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
        rows = conn.execute(
            "SELECT id, type, filePath, userName, status FROM user_info ORDER BY id"
        ).fetchall()
    accounts = []
    for row in rows:
        status = fixed_browser_account_status(row[1]) if row[1] >= 5 else int(
            (Path(BASE_DIR) / "cookiesFile" / row[2]
        ).is_file())
        accounts.append({
            "id": row[0],
            "type": row[1],
            "platform": PLATFORM_NAMES.get(row[1], "未知"),
            "filePath": row[2],
            "name": row[3],
            "status": "ok" if status else "missing",
            "loginMode": "shared_chrome" if row[1] >= 5 else "cookie",
        })
    return jsonify({
        "code": 200,
        "data": {
            "service": "ok",
            "cdp": bool(fixed_browser_account_status(5)
                        or fixed_browser_account_status(6)
                        or fixed_browser_account_status(7)),
            "accounts": accounts,
        },
        "msg": None,
    })

# 获取当前目录（假设 index.html 和 assets 在这里）
current_dir = os.path.dirname(os.path.abspath(__file__))

# 处理所有静态资源请求（未来打包用）
@app.route('/assets/<filename>')
def custom_static(filename):
    return send_from_directory(os.path.join(current_dir, 'assets'), filename)

# 处理 favicon.ico 静态资源（未来打包用）
@app.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(current_dir, 'assets'), 'vite.svg')

@app.route('/vite.svg')
def vite_svg():
    return send_from_directory(os.path.join(current_dir, 'assets'), 'vite.svg')

# （未来打包用）
@app.route('/')
def index():  # put application's code here
    return send_from_directory(current_dir, 'index.html')

@app.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({
            "code": 400,
            "data": None,
            "msg": "No file part in the request"
        }), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({
            "code": 400,
            "data": None,
            "msg": "No selected file"
        }), 400
    try:
        # 保存文件到指定位置
        uuid_v1 = uuid.uuid1()
        print(f"UUID v1: {uuid_v1}")
        safe_name = secure_filename(file.filename)
        if not safe_name:
            return jsonify({"code": 400, "data": None, "msg": "Invalid filename"}), 400
        filepath = Path(BASE_DIR / "videoFile" / f"{uuid_v1}_{safe_name}")
        file.save(filepath)
        return jsonify({"code":200,"msg": "File uploaded successfully", "data": f"{uuid_v1}_{safe_name}"}), 200
    except Exception as e:
        return jsonify({"code":500,"msg": str(e),"data":None}), 500

@app.route('/getFile', methods=['GET'])
def get_file():
    # 获取 filename 参数
    filename = request.args.get('filename')

    if not filename:
        return jsonify({"code": 400, "msg": "filename is required", "data": None}), 400

    # 防止路径穿越攻击
    if '..' in filename or filename.startswith('/'):
        return jsonify({"code": 400, "msg": "Invalid filename", "data": None}), 400

    # 拼接完整路径
    file_path = str(Path(BASE_DIR / "videoFile"))

    # 返回文件
    return send_from_directory(file_path,filename)


@app.route('/uploadSave', methods=['POST'])
def upload_save():
    if 'file' not in request.files:
        return jsonify({
            "code": 400,
            "data": None,
            "msg": "No file part in the request"
        }), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({
            "code": 400,
            "data": None,
            "msg": "No selected file"
        }), 400

    # 获取表单中的自定义文件名（可选）
    custom_filename = request.form.get('filename', None)
    if custom_filename:
        filename = secure_filename(custom_filename + "." + file.filename.split('.')[-1])
    else:
        filename = secure_filename(file.filename)
    if not filename:
        return jsonify({"code": 400, "data": None, "msg": "Invalid filename"}), 400

    try:
        # 生成 UUID v1
        uuid_v1 = uuid.uuid1()
        print(f"UUID v1: {uuid_v1}")

        # 构造文件名和路径
        final_filename = f"{uuid_v1}_{filename}"
        filepath = Path(BASE_DIR / "videoFile" / f"{uuid_v1}_{filename}")

        # 保存文件
        file.save(filepath)

        with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                                INSERT INTO file_records (filename, filesize, file_path)
            VALUES (?, ?, ?)
                                ''', (filename, round(float(os.path.getsize(filepath)) / (1024 * 1024),2), final_filename))
            conn.commit()
            print("✅ 上传文件已记录")

        return jsonify({
            "code": 200,
            "msg": "File uploaded and saved successfully",
            "data": {
                "filename": filename,
                "filepath": final_filename
            }
        }), 200

    except Exception as e:
        print(f"Upload failed: {e}")
        return jsonify({
            "code": 500,
            "msg": f"upload failed: {e}",
            "data": None
        }), 500

@app.route('/getFiles', methods=['GET'])
def get_all_files():
    try:
        # 使用 with 自动管理数据库连接
        with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
            conn.row_factory = sqlite3.Row  # 允许通过列名访问结果
            cursor = conn.cursor()

            # 查询所有记录
            cursor.execute("SELECT * FROM file_records")
            rows = cursor.fetchall()

            # 将结果转为字典列表，并提取UUID
            data = []
            for row in rows:
                row_dict = dict(row)
                # 从 file_path 中提取 UUID (文件名的第一部分，下划线前)
                if row_dict.get('file_path'):
                    file_path_parts = row_dict['file_path'].split('_', 1)  # 只分割第一个下划线
                    if len(file_path_parts) > 0:
                        row_dict['uuid'] = file_path_parts[0]  # UUID 部分
                    else:
                        row_dict['uuid'] = ''
                else:
                    row_dict['uuid'] = ''
                data.append(row_dict)

            return jsonify({
                "code": 200,
                "msg": "success",
                "data": data
            }), 200
    except Exception as e:
        return jsonify({
            "code": 500,
            "msg": str("get file failed!"),
            "data": None
        }), 500


@app.route("/getAccounts", methods=['GET'])
def getAccounts():
    """快速获取所有账号信息，不进行cookie验证"""
    try:
        with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute('''
            SELECT * FROM user_info''')
            rows = cursor.fetchall()
            rows_list = [list(row) for row in rows]

            print("\n📋 当前数据表内容（快速获取）：")
            for row in rows:
                print(row)

            return jsonify(
                {
                    "code": 200,
                    "msg": None,
                    "data": rows_list
                }), 200
    except Exception as e:
        print(f"获取账号列表时出错: {str(e)}")
        return jsonify({
            "code": 500,
            "msg": f"获取账号列表失败: {str(e)}",
            "data": None
        }), 500


@app.route("/getValidAccounts",methods=['GET'])
def getValidAccounts():
    """读取本地账号状态，不在页面刷新时启动浏览器访问平台。"""
    with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
        cursor = conn.cursor()
        cursor.execute('''
        SELECT * FROM user_info''')
        rows = cursor.fetchall()
        rows_list = [list(row) for row in rows]
        for row in rows_list:
            if row[1] in FIXED_BROWSER_ACCOUNTS:
                row[4] = fixed_browser_account_status(row[1])
                cursor.execute(
                    "UPDATE user_info SET status = ? WHERE id = ?",
                    (row[4], row[0]),
                )
                conn.commit()
                continue
            cookie_file = Path(BASE_DIR / "cookiesFile" / row[2])
            if not cookie_file.is_file() or cookie_file.stat().st_size == 0:
                row[4] = 0
                cursor.execute('''
                UPDATE user_info 
                SET status = ? 
                WHERE id = ?
                ''', (0,row[0]))
                conn.commit()
        return jsonify(
                        {
                            "code": 200,
                            "msg": None,
                            "data": rows_list
                        }),200


@app.route('/account', methods=['POST'])
def add_fixed_browser_account():
    """登记使用固定 Chrome 登录态的扩展平台账号。"""
    data = request.get_json() or {}
    platform_name = str(data.get("platform", "")).strip()
    user_name = str(data.get("name", "")).strip()
    type_by_name = {
        name: platform_type
        for platform_type, (name, _) in FIXED_BROWSER_ACCOUNTS.items()
    }
    platform_type = type_by_name.get(platform_name)
    if not platform_type:
        return jsonify({
            "code": 400,
            "msg": "该平台仍需通过原扫码流程添加账号",
            "data": None,
        }), 400
    if not user_name:
        return jsonify({"code": 400, "msg": "账号名称不能为空", "data": None}), 400

    status = fixed_browser_account_status(platform_type)
    file_path = f"shared-chrome-profile-{platform_type}"
    with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id FROM user_info WHERE type = ? AND userName = ?",
            (platform_type, user_name),
        )
        existing = cursor.fetchone()
        if existing:
            cursor.execute(
                "UPDATE user_info SET filePath = ?, status = ? WHERE id = ?",
                (file_path, status, existing[0]),
            )
            account_id = existing[0]
        else:
            cursor.execute(
                """
                INSERT INTO user_info (type, filePath, userName, status)
                VALUES (?, ?, ?, ?)
                """,
                (platform_type, file_path, user_name, status),
            )
            account_id = cursor.lastrowid
        conn.commit()

    return jsonify({
        "code": 200,
        "msg": "固定浏览器账号已添加",
        "data": {
            "id": account_id,
            "type": platform_type,
            "name": user_name,
            "status": status,
        },
    }), 200

@app.route('/deleteFile', methods=['GET'])
def delete_file():
    file_id = request.args.get('id')

    if not file_id or not file_id.isdigit():
        return jsonify({
            "code": 400,
            "msg": "Invalid or missing file ID",
            "data": None
        }), 400

    try:
        # 获取数据库连接
        with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            # 查询要删除的记录
            cursor.execute("SELECT * FROM file_records WHERE id = ?", (file_id,))
            record = cursor.fetchone()

            if not record:
                return jsonify({
                    "code": 404,
                    "msg": "File not found",
                    "data": None
                }), 404

            record = dict(record)

            # 获取文件路径并删除实际文件
            file_path = Path(BASE_DIR / "videoFile" / record['file_path'])
            if file_path.exists():
                try:
                    file_path.unlink()  # 删除文件
                    print(f"✅ 实际文件已删除: {file_path}")
                except Exception as e:
                    print(f"⚠️ 删除实际文件失败: {e}")
                    # 即使删除文件失败，也要继续删除数据库记录，避免数据不一致
            else:
                print(f"⚠️ 实际文件不存在: {file_path}")

            # 删除数据库记录
            cursor.execute("DELETE FROM file_records WHERE id = ?", (file_id,))
            conn.commit()

        return jsonify({
            "code": 200,
            "msg": "File deleted successfully",
            "data": {
                "id": record['id'],
                "filename": record['filename']
            }
        }), 200

    except Exception as e:
        return jsonify({
            "code": 500,
            "msg": str("delete failed!"),
            "data": None
        }), 500

@app.route('/deleteAccount', methods=['GET'])
def delete_account():
    account_id = request.args.get('id')

    if not account_id or not account_id.isdigit():
        return jsonify({
            "code": 400,
            "msg": "Invalid or missing account ID",
            "data": None
        }), 400

    account_id = int(account_id)

    try:
        # 获取数据库连接
        with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            # 查询要删除的记录
            cursor.execute("SELECT * FROM user_info WHERE id = ?", (account_id,))
            record = cursor.fetchone()

            if not record:
                return jsonify({
                    "code": 404,
                    "msg": "account not found",
                    "data": None
                }), 404

            record = dict(record)

            # 删除关联的cookie文件
            if record.get('filePath'):
                cookie_file_path = Path(BASE_DIR / "cookiesFile" / record['filePath'])
                if cookie_file_path.exists():
                    try:
                        cookie_file_path.unlink()
                        print(f"✅ Cookie文件已删除: {cookie_file_path}")
                    except Exception as e:
                        print(f"⚠️ 删除Cookie文件失败: {e}")

            # 删除数据库记录
            cursor.execute("DELETE FROM user_info WHERE id = ?", (account_id,))
            conn.commit()

        return jsonify({
            "code": 200,
            "msg": "account deleted successfully",
            "data": None
        }), 200

    except Exception as e:
        return jsonify({
            "code": 500,
            "msg": f"delete failed: {str(e)}",
            "data": None
        }), 500


# SSE 登录接口
@app.route('/login')
def login():
    # 1 小红书 2 视频号 3 抖音 4 快手
    type = request.args.get('type')
    # 账号名
    id = request.args.get('id')

    # 模拟一个用于异步通信的队列
    status_queue = Queue()
    active_queues[id] = status_queue

    def on_close():
        print(f"清理队列: {id}")
        del active_queues[id]
    # 启动异步任务线程
    thread = threading.Thread(target=run_async_function, args=(type,id,status_queue), daemon=True)
    thread.start()
    response = Response(sse_stream(status_queue,), mimetype='text/event-stream')
    response.headers['Cache-Control'] = 'no-cache'
    response.headers['X-Accel-Buffering'] = 'no'  # 关键：禁用 Nginx 缓冲
    response.headers['Content-Type'] = 'text/event-stream'
    response.headers['Connection'] = 'keep-alive'
    return response

@app.route('/postVideo', methods=['POST'])
def postVideo():
    # 工作流2不再开放旧版批量发布入口。保留 410 响应只为让旧客户端得到
    # 明确错误，任何媒体处理都必须从 /draftAbsolute 的草稿安全路径进入。
    return jsonify({
        "code": 410,
        "msg": "正式发布入口已永久禁用，请使用工作流2的草稿窗口",
        "data": None,
    }), 410

    # 下方是上游项目的兼容参考代码；由于上面的无条件返回，永远不会执行。
    # 获取JSON数据
    data = request.get_json()

    if not data:
        return jsonify({"code": 400, "msg": "请求数据不能为空", "data": None}), 400

    # 从JSON数据中提取fileList和accountList
    file_list = data.get('fileList', [])
    account_list = data.get('accountList', [])
    type = data.get('type')
    title = data.get('title')
    description = data.get('description', '')
    tags = data.get('tags')
    category = data.get('category')
    enableTimer = False
    if category == 0:
        category = None
    productLink = data.get('productLink', '')
    productTitle = data.get('productTitle', '')
    thumbnail_path = data.get('thumbnail', '')
    is_draft = True

    videos_per_day = data.get('videosPerDay')
    daily_times = data.get('dailyTimes')
    start_days = data.get('startDays')

    # 参数校验
    if not file_list:
        return jsonify({"code": 400, "msg": "文件列表不能为空", "data": None}), 400
    if type in (1, 2, 3, 4) and not account_list:
        return jsonify({"code": 400, "msg": "账号列表不能为空", "data": None}), 400
    if not type:
        return jsonify({"code": 400, "msg": "平台类型不能为空", "data": None}), 400
    if not title:
        return jsonify({"code": 400, "msg": "标题不能为空", "data": None}), 400

    # 打印获取到的数据（仅作为示例）
    print("File List:", file_list)
    print("Account List:", account_list)

    try:
        result = None
        match type:
            case 1:
                post_video_xhs(title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times,
                                   start_days)
            case 2:
                post_video_tencent(title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times,
                                   start_days, is_draft)
            case 3:
                post_video_DouYin(title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times,
                          start_days, thumbnail_path, productLink, productTitle)
            case 4:
                post_video_ks(title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times,
                          start_days)
            case 5 | 6 | 7:
                result = process_extended_draft(type, file_list, title, tags, description)
            case _:
                return jsonify({"code": 400, "msg": f"不支持的平台类型: {type}", "data": None}), 400

        # 返回响应给客户端
        return jsonify(
            {
                "code": 200,
                "msg": "草稿保存任务已提交",
                "data": result
            }), 200
    except Exception as e:
        print(f"保存草稿时出错: {str(e)}")
        return jsonify({
            "code": 500,
            "msg": f"草稿保存失败: {str(e)}",
            "data": None
        }), 500


@app.route('/updateUserinfo', methods=['POST'])
def updateUserinfo():
    # 获取JSON数据
    data = request.get_json()

    # 从JSON数据中提取 type 和 userName
    user_id = data.get('id')
    type = data.get('type')
    userName = data.get('userName')
    try:
        # 获取数据库连接
        with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            # 更新数据库记录
            cursor.execute('''
                           UPDATE user_info
                           SET type     = ?,
                               userName = ?
                           WHERE id = ?;
                           ''', (type, userName, user_id))
            conn.commit()

        return jsonify({
            "code": 200,
            "msg": "account update successfully",
            "data": None
        }), 200

    except Exception as e:
        return jsonify({
            "code": 500,
            "msg": str("update failed!"),
            "data": None
        }), 500

@app.route('/postVideoBatch', methods=['POST'])
def postVideoBatch():
    return jsonify({
        "code": 410,
        "msg": "批量正式发布入口已永久禁用，请使用工作流2的草稿窗口",
        "data": None,
    }), 410

    # 下方是上游项目的兼容参考代码；由于上面的无条件返回，永远不会执行。
    data_list = request.get_json()

    if not isinstance(data_list, list):
        return jsonify({"code": 400, "msg": "Expected a JSON array", "data": None}), 400
    for data in data_list:
        # 从JSON数据中提取fileList和accountList
        file_list = data.get('fileList', [])
        account_list = data.get('accountList', [])
        type = data.get('type')
        title = data.get('title')
        description = data.get('description', '')
        tags = data.get('tags')
        category = data.get('category')
        enableTimer = data.get('enableTimer')
        if category == 0:
            category = None
        productLink = data.get('productLink', '')
        productTitle = data.get('productTitle', '')
        is_draft = True

        videos_per_day = data.get('videosPerDay')
        daily_times = data.get('dailyTimes')
        start_days = data.get('startDays')
        # 打印获取到的数据（仅作为示例）
        print("File List:", file_list)
        print("Account List:", account_list)
        match type:
            case 1:
                post_video_xhs(title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times,
                               start_days)
            case 2:
                post_video_tencent(title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times,
                                   start_days, is_draft)
            case 3:
                post_video_DouYin(title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times,
                          start_days, productLink, productTitle)
            case 4:
                post_video_ks(title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times,
                          start_days)
            case 5 | 6 | 7:
                process_extended_draft(type, file_list, title, tags, description)
    # 返回响应给客户端
    return jsonify(
        {
            "code": 200,
            "msg": None,
            "data": None
        }), 200

# Cookie文件上传API
@app.route('/uploadCookie', methods=['POST'])
def upload_cookie():
    try:
        if 'file' not in request.files:
            return jsonify({
                "code": 400,
                "msg": "没有找到Cookie文件",
                "data": None
            }), 400

        file = request.files['file']
        if file.filename == '':
            return jsonify({
                "code": 400,
                "msg": "Cookie文件名不能为空",
                "data": None
            }), 400

        if not file.filename.endswith('.json'):
            return jsonify({
                "code": 400,
                "msg": "Cookie文件必须是JSON格式",
                "data": None
            }), 400

        # 获取账号信息
        account_id = request.form.get('id')
        platform = request.form.get('platform')

        if not account_id or not platform:
            return jsonify({
                "code": 400,
                "msg": "缺少账号ID或平台信息",
                "data": None
            }), 400

        # 从数据库获取账号的文件路径
        with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute('SELECT filePath FROM user_info WHERE id = ?', (account_id,))
            result = cursor.fetchone()

        if not result:
            return jsonify({
                "code": 500,
                "msg": "账号不存在",
                "data": None
            }), 404

        # 保存上传的Cookie文件到对应路径
        cookie_file_path = Path(BASE_DIR / "cookiesFile" / result['filePath'])
        cookie_file_path.parent.mkdir(parents=True, exist_ok=True)

        file.save(str(cookie_file_path))

        # 更新数据库中的账号信息（可选，比如更新更新时间）
        # 这里可以根据需要添加额外的处理逻辑

        return jsonify({
            "code": 200,
            "msg": "Cookie文件上传成功",
            "data": None
        }), 200

    except Exception as e:
        print(f"上传Cookie文件时出错: {str(e)}")
        return jsonify({
            "code": 500,
            "msg": f"上传Cookie文件失败: {str(e)}",
            "data": None
        }), 500


# Cookie文件下载API
@app.route('/downloadCookie', methods=['GET'])
def download_cookie():
    try:
        file_path = request.args.get('filePath')
        if not file_path:
            return jsonify({
                "code": 500,
                "msg": "缺少文件路径参数",
                "data": None
            }), 400

        # 验证文件路径的安全性，防止路径遍历攻击
        cookie_file_path = Path(BASE_DIR / "cookiesFile" / file_path).resolve()
        base_path = Path(BASE_DIR / "cookiesFile").resolve()

        if not cookie_file_path.is_relative_to(base_path):
            return jsonify({
                "code": 500,
                "msg": "非法文件路径",
                "data": None
            }), 400

        if not cookie_file_path.exists():
            return jsonify({
                "code": 500,
                "msg": "Cookie文件不存在",
                "data": None
            }), 404

        # 返回文件
        return send_from_directory(
            directory=str(cookie_file_path.parent),
            path=cookie_file_path.name,
            as_attachment=True
        )

    except Exception as e:
        print(f"下载Cookie文件时出错: {str(e)}")
        return jsonify({
            "code": 500,
            "msg": f"下载Cookie文件失败: {str(e)}",
            "data": None
        }), 500


# 包装函数：在线程中运行异步函数
def run_async_function(type,id,status_queue):
    match type:
        case '1':
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(xiaohongshu_cookie_gen(id, status_queue))
            loop.close()
        case '2':
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(get_tencent_cookie(id,status_queue))
            loop.close()
        case '3':
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(douyin_cookie_gen(id,status_queue))
            loop.close()
        case '4':
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(get_ks_cookie(id,status_queue))
            loop.close()

# SSE 流生成器函数
def sse_stream(status_queue):
    while True:
        if not status_queue.empty():
            msg = status_queue.get()
            yield f"data: {msg}\n\n"
        else:
            # 避免 CPU 占满
            time.sleep(0.1)

if __name__ == '__main__':
    app.run(host='0.0.0.0' ,port=5409)
