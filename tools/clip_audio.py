#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从一段配音/语音包里抽出 5~30 秒「干净人声」当克隆参考。

做法：
  1. 用 ffmpeg 的 silencedetect 找出安静段，反推出说话段；
  2. 挑时长够的说话段，按顺序拼起来（中间留 0.25s 空白），凑够目标秒数；
  3. 统一成 24kHz 单声道 wav，并做响度归一化（-16 LUFS）。

用法：
    python clip_audio.py 录音.m4a -o ref.wav --target 15
    python clip_audio.py in.aac -o out.wav --start 12 --dur 10     # 手动截一段

依赖 ffmpeg：优先用 PATH 里的，找不到就用 imageio-ffmpeg 自带的。
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile


def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        sys.exit("找不到 ffmpeg：装一下 imageio-ffmpeg（pip install imageio-ffmpeg）")


def detect_speech(ff, src, noise="-32dB", min_sil=0.55):
    """返回 [(start, end), ...] 说话段。"""
    p = subprocess.run(
        [ff, "-hide_banner", "-nostats", "-i", src, "-af", f"silencedetect=noise={noise}:d={min_sil}", "-f", "null", "-"],
        capture_output=True,
        text=True,
        errors="ignore",
    )
    log = p.stderr
    dur = None
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", log)
    if m:
        dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))

    sils = []
    for m in re.finditer(r"silence_start: ([\d.]+)", log):
        sils.append([float(m.group(1)), None])
    for i, m in enumerate(re.finditer(r"silence_end: ([\d.]+)", log)):
        if i < len(sils):
            sils[i][1] = float(m.group(1))

    speech = []
    cur = 0.0
    for s, e in sils:
        if s > cur:
            speech.append((cur, s))
        cur = e if e is not None else (dur or s)
    if dur and cur < dur:
        speech.append((cur, dur))
    return speech


def clean_segments(speech, min_len=0.9, gap=0.08):
    """去掉太短的碎句，修剪前后空白。"""
    out = []
    for s, e in speech:
        s2, e2 = s + gap, e - gap
        if e2 - s2 >= min_len:
            out.append((s2, e2))
    return out


def pick(segs, target):
    """按时间顺序贪心挑，凑够 target 秒；优先较长的句子。"""
    chosen = []
    total = 0.0
    for s, e in sorted(segs, key=lambda x: -(x[1] - x[0])):
        if total >= target:
            break
        if e - s > 12:  # 太长的先切一半，避免一整段带背景音乐
            e = s + 12
        chosen.append((s, e))
        total += e - s
    chosen.sort()
    return chosen, total


def clip_concatenate(ff, src, segs, out, gap=0.25):
    """每句先用 atrim 截出来，末尾 pad 一小段静音，再整体 concat。"""
    parts = []
    for i, (s, e) in enumerate(segs):
        parts.append(
            f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS,"
            f"aresample=24000,aformat=sample_fmts=flt:channel_layouts=mono,"
            f"apad=pad_dur={gap}[a{i}]"
        )
    chain = "".join(f"[a{i}]" for i in range(len(segs)))
    filt = ";".join(parts) + f";{chain}concat=n={len(segs)}:v=0:a=1[cat];[cat]loudnorm=I=-16:TP=-1.5:LRA=11[out]"
    cmd = [ff, "-hide_banner", "-y", "-i", src, "-filter_complex", filt, "-map", "[out]",
           "-ar", "24000", "-ac", "1", out]
    p = subprocess.run(cmd, capture_output=True, text=True, errors="ignore")
    if p.returncode != 0:
        raise RuntimeError(p.stderr[-1200:])
    return out


def clip_simple(ff, src, start, dur, out):
    cmd = [ff, "-hide_banner", "-y", "-ss", str(start), "-t", str(dur), "-i", src,
           "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "24000", "-ac", "1", out]
    p = subprocess.run(cmd, capture_output=True, text=True, errors="ignore")
    if p.returncode != 0:
        raise RuntimeError(p.stderr[-1200:])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--target", type=float, default=15.0, help="拼多久的人声（秒）")
    ap.add_argument("--start", type=float, default=None, help="手动模式的起点")
    ap.add_argument("--dur", type=float, default=None, help="手动模式的时长")
    ap.add_argument("--noise", default="-32dB")
    ap.add_argument("--min-len", type=float, default=0.9)
    args = ap.parse_args()

    ff = find_ffmpeg()
    if args.start is not None and args.dur:
        print(f"手动截取 {args.start}s + {args.dur}s")
        clip_simple(ff, args.src, args.start, args.dur, args.out)
    else:
        speech = detect_speech(ff, args.src, args.noise)
        segs = clean_segments(speech, args.min_len)
        if not segs:
            sys.exit("没检测到说话段：试试把 --noise 调小（比如 -40dB）")
        chosen, total = pick(segs, args.target)
        print(f"检测到 {len(segs)} 句，选 {len(chosen)} 句，共 {total:.1f}s：")
        for s, e in chosen:
            print(f"  {s:7.2f} → {e:7.2f}  ({e - s:.1f}s)")
        clip_concatenate(ff, args.src, chosen, args.out)

    size = os.path.getsize(args.out)
    print(f"写出 {args.out}（{size / 1024:.0f} KB）")


if __name__ == "__main__":
    main()
