#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ModelScope 多线程 + 断点续传下载器（单连接被限速时用）。

用法：
    python fetch_model.py --repo IndexTeam/IndexTTS-2.5 --out D:\\tts\\index-tts\\checkpoints \
        --files gpt.pth codec.pth s2mel.pth --threads 24
"""
import argparse
import json
import os
import sys
import threading
import time
import urllib.request

CHUNK = 4 * 1024 * 1024       # 每次 Range 请求 4MB
SOCK_TIMEOUT = 30
MAX_RETRY = 40
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) modelscope-dl/1.0"}


def api(path, **params):
    q = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"https://modelscope.cn/api/v1/models/{path}" + (f"?{q}" if q else "")
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=SOCK_TIMEOUT) as r:
        return json.load(r)


def list_files(repo):
    d = api(f"{repo}/repo/files", Revision="master", Recursive="True")
    return d["Data"]["Files"]


def fetch_range(url, headers):
    req = urllib.request.Request(url, headers={**UA, **headers})
    return urllib.request.urlopen(req, timeout=SOCK_TIMEOUT)


def worker(url, part_path, start, end, label, done_flag):
    """把 [start,end) 写进 part_path（可从已有大小续传）。"""
    fails = 0
    while True:
        have = os.path.getsize(part_path) if os.path.exists(part_path) else 0
        cur = start + have
        if cur >= end:
            done_flag[0] += 1
            print(f"  {label} 完成 ({have / 1e6:.1f}MB)", flush=True)
            return
        want_end = min(cur + CHUNK, end) - 1
        try:
            resp = fetch_range(url, {"Range": f"bytes={cur}-{want_end}"})
            with open(part_path, "ab") as f:
                while True:
                    b = resp.read(262144)
                    if not b:
                        break
                    f.write(b)
            resp.close()
            fails = 0
        except Exception as e:  # noqa: BLE001
            fails += 1
            if fails > MAX_RETRY:
                print(f"  {label} 放弃：{e}", flush=True)
                done_flag[0] += 1
                return
            time.sleep(min(15, 1 + fails))


def download(url, out, threads):
    total = int(fetch_range(url, {"Range": "bytes=0-0"}).headers["Content-Range"].split("/")[1])
    have = 0
    for i in range(threads):
        p = f"{out}.part{i}"
        if os.path.exists(p):
            have += os.path.getsize(p)
    if have >= total and not os.path.exists(out):
        concat(out, threads)
        return
    print(f"  总大小 {total / 1e6:.1f}MB，已有 {have / 1e6:.1f}MB", flush=True)

    per = -(-total // threads)
    done = [0]
    ts = []
    for i in range(threads):
        start = i * per
        end = min(start + per, total)
        if start >= end:
            done[0] += 1
            continue
        p = f"{out}.part{i}"
        t = threading.Thread(target=worker, args=(url, p, start, end, f"part{i}", done), daemon=True)
        t.start()
        ts.append(t)

    last = -1
    while done[0] < threads:
        time.sleep(5)
        got = sum(os.path.getsize(f"{out}.part{i}") for i in range(threads) if os.path.exists(f"{out}.part{i}"))
        pct = got * 100.0 / total
        if int(pct) != last:
            last = int(pct)
            print(f"  {pct:5.1f}%  {got / 1e6:7.1f}/{total / 1e6:.1f}MB", flush=True)

    concat(out, threads)


def concat(out, threads):
    print(f"  拼接 {threads} 个分片 → {os.path.basename(out)}", flush=True)
    with open(out, "wb") as w:
        for i in range(threads):
            p = f"{out}.part{i}"
            if os.path.exists(p):
                with open(p, "rb") as r:
                    while True:
                        b = r.read(8 * 1024 * 1024)
                        if not b:
                            break
                        w.write(b)
                os.remove(p)
    print(f"  完成 {os.path.getsize(out) / 1e6:.1f}MB", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="IndexTeam/IndexTTS-2.5")
    ap.add_argument("--out", required=True)
    ap.add_argument("--files", nargs="*", default=["gpt.pth", "codec.pth", "s2mel.pth"])
    ap.add_argument("--threads", type=int, default=24)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    files = {f["Path"]: f for f in list_files(args.repo)}
    for name in args.files:
        info = files.get(name)
        if not info:
            print(f"!! 仓库里没有 {name}", flush=True)
            continue
        out = os.path.join(args.out, name)
        size = int(info.get("Size") or 0)
        if os.path.exists(out) and size and os.path.getsize(out) == size:
            print(f"{name} 已完整（{size / 1e6:.1f}MB），跳过", flush=True)
            continue
        url = f"https://modelscope.cn/models/{args.repo}/resolve/master/{name}"
        print(f"== {name}  {size / 1e6:.1f}MB", flush=True)
        try:
            download(url, out, args.threads)
        except Exception as e:  # noqa: BLE001
            print(f"!! {name} 失败：{e}", flush=True)


if __name__ == "__main__":
    main()
