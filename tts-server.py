#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
IndexTTS-2.5 的极简本地推理服务（给「桌边」用）。

只做两件事：
    GET  /health  → {"ready": bool, "loading": bool, "error": str, "device": str}
    POST /tts     → {"text": "...", "ref_audio": "C:\\...\\ref.wav", "ref_text": "...", "emo": "", "speed": 1.0}
                    返回 audio/wav 字节

用标准库 http.server，不额外依赖 fastapi/gradio。

启动（用装好的 venv）：
    C:\\Users\\<你>\\index-tts\\.venv\\Scripts\\python.exe tts-server.py --port 8756
"""

import argparse
import json
import os
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {
    "ready": False,
    "loading": True,
    "error": "",
    "device": "",
    "model": "",
}
TTS = None
INFER_LOCK = threading.Lock()


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def load_model(args):
    global TTS
    try:
        log(f"采样步数 INDEXTTS_DIFFUSION_STEPS={os.environ.get('INDEXTTS_DIFFUSION_STEPS', '(默认 25)')}")
        sys.path.insert(0, args.repo)
        if args.repo not in os.getcwd():
            os.chdir(args.repo)

        import torch

        device = "cuda" if torch.cuda.is_available() else "cpu"
        STATE["device"] = device
        if device == "cuda":
            try:
                STATE["device"] = f"cuda:{torch.cuda.get_device_name(0)}"
            except Exception:
                pass
            log(f"GPU: {STATE['device']}  VRAM {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f}GB")

        if args.version == "2.5":
            from indextts.infer_v2_5 import IndexTTS2
        else:
            from indextts.infer_v2 import IndexTTS2

        kwargs = dict(
            cfg_path=os.path.join(args.model_dir, "config.yaml"),
            model_dir=args.model_dir,
            use_cuda_kernel=None,
            use_deepspeed=False,
            use_qwen_emo=False,
        )
        if args.version == "2.5":
            kwargs["use_bf16"] = bool(args.bf16 and device == "cuda" and torch.cuda.is_bf16_supported())
            if kwargs["use_bf16"]:
                log("使用 bf16 半精度")
        else:
            kwargs["use_fp16"] = bool(args.fp16)

        t0 = time.time()
        TTS = IndexTTS2(**kwargs)
        STATE["model"] = args.version
        STATE["ready"] = True
        STATE["loading"] = False
        log(f"模型加载完成，用时 {time.time() - t0:.1f}s")
    except Exception as e:
        STATE["loading"] = False
        STATE["error"] = f"{e}"
        log("加载失败：\n" + traceback.format_exc())


def run_infer(payload):
    text = (payload.get("text") or "").strip()
    ref = (payload.get("ref_audio") or "").strip()
    if not text:
        raise ValueError("text 为空")
    if not ref or not os.path.exists(ref):
        raise ValueError("参考音频不存在：" + ref)

    lang = (payload.get("lang") or "ZH").upper()
    if lang not in ("ZH", "EN", "JA", "ES", "ZHEN"):
        lang = "ZH"

    emo = (payload.get("emo") or "").strip()
    kwargs = dict(
        spk_audio_prompt=ref,
        text=text,
        output_path=os.path.join(tempfile.gettempdir(), f"fish_tts_{os.getpid()}.wav"),
        lang=lang,
        verbose=False,
        # 每段之间默认 200ms 静音，我们按句子切得很碎，压到 60ms 听着更连贯
        interval_silence=150,
    )
    if emo and os.path.exists(emo):
        kwargs["emo_audio_prompt"] = emo
        kwargs["emo_alpha"] = float(payload.get("emo_alpha") or 0.8)
    emo_text = (payload.get("emo_text") or "").strip()
    if emo_text:
        kwargs["use_emo_text"] = True
        kwargs["emo_text"] = emo_text

    speed = float(payload.get("speed") or 1.0)
    if abs(speed - 1.0) > 0.01:
        kwargs["duration_factor"] = 1.0 / max(0.25, min(4.0, speed))

    with INFER_LOCK:
        t0 = time.time()
        out = TTS.infer(**kwargs)
        log(f"合成 {len(text)} 字，用时 {time.time() - t0:.1f}s")

    path = out if isinstance(out, str) and os.path.exists(out) else kwargs["output_path"]
    with open(path, "rb") as f:
        return f.read()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 安静点
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            self._json(200, STATE)
        else:
            self._json(404, {"error": "只支持 /health 和 /tts"})

    def do_POST(self):
        if self.path.split("?")[0] != "/tts":
            self._json(404, {"error": "只支持 /health 和 /tts"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception as e:
            self._json(400, {"error": f"请求体不是合法 JSON：{e}"})
            return

        if not STATE["ready"]:
            self._json(503, {"error": STATE["error"] or "模型还在加载", "loading": STATE["loading"]})
            return
        try:
            audio = run_infer(payload)
        except Exception as e:
            log("合成失败：\n" + traceback.format_exc())
            self._json(500, {"error": str(e)})
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8756)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--repo", default=os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--model-dir", dest="model_dir", default="")
    ap.add_argument("--version", default="2.5", choices=["2", "2.5"])
    ap.add_argument("--bf16", action="store_true", default=True)
    ap.add_argument("--fp16", action="store_true", default=False)
    args = ap.parse_args()
    if not args.model_dir:
        args.model_dir = os.path.join(args.repo, "checkpoints")

    log(f"repo={args.repo}  model_dir={args.model_dir}  version={args.version}")
    threading.Thread(target=load_model, args=(args,), daemon=True).start()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f"监听 http://{args.host}:{args.port}  （模型后台加载中）")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("退出")


if __name__ == "__main__":
    main()
