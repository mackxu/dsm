#!/usr/bin/env python3
"""DSM 读取代理。

由 Electron 主进程通过白名单中的 Python 启动：

    python -I -S -B -u dsm-file-reader.py <filePath> <maxBytes>

- stdout 只输出文件原始字节，不写任何日志
- stderr 输出结构化错误 JSON
- 退出码：0 成功，1 读取失败，2 超过大小上限

不要在此脚本中使用 print 或 logging，否则会破坏二进制内容。
只使用 Python 标准库，兼容 Python 3.8+。
"""

import json
import os
import stat
import sys

CHUNK_SIZE = 64 * 1024


def fail(code, message, exit_code):
    """写出结构化错误并退出。"""
    try:
        sys.stderr.write(
            json.dumps({"code": code, "message": message}, ensure_ascii=True)
        )
        sys.stderr.flush()
    except Exception:
        # stderr 不可用时只能通过退出码报告。
        pass
    raise SystemExit(exit_code)


def write_all(data):
    """把全部字节写入 stdout，处理 partial write。"""
    view = memoryview(data)
    while view:
        written = sys.stdout.buffer.write(view)
        if written is None:
            written = len(view)
        view = view[written:]


def main():
    if len(sys.argv) != 3:
        fail("FILE_READ_FAILED", "参数无效", 1)

    file_path = sys.argv[1]
    try:
        max_bytes = int(sys.argv[2])
    except ValueError:
        fail("FILE_READ_FAILED", "读取上限无效", 1)

    if max_bytes <= 0:
        fail("FILE_READ_FAILED", "读取上限无效", 1)

    try:
        info = os.stat(file_path)
    except OSError as error:
        fail("FILE_READ_FAILED", f"无法访问文件：{error}", 1)

    if not stat.S_ISREG(info.st_mode):
        fail("FILE_READ_FAILED", "目标不是普通文件", 1)
    if info.st_size <= 0:
        fail("FILE_READ_FAILED", "文件为空", 1)

    total = 0
    try:
        with open(file_path, "rb", buffering=0) as source:
            while True:
                chunk = source.read(CHUNK_SIZE)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    fail("FILE_TOO_LARGE", "文件超过上传大小上限", 2)
                write_all(chunk)

        if total == 0:
            fail("FILE_READ_FAILED", "文件为空", 1)
        sys.stdout.buffer.flush()
    except BrokenPipeError:
        os._exit(1)
    except OSError as error:
        fail("FILE_READ_FAILED", f"读取文件失败：{error}", 1)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as error:
        fail("FILE_READ_FAILED", f"读取文件失败：{error}", 1)
