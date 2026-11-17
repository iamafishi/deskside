#!/usr/bin/env bash
# 把 IndexTTS-2.5 的模型文件拖下来（多线程分段，单连接被限速）
set -u
BASE="https://www.modelscope.cn/models/IndexTeam/IndexTTS-2.5/resolve/master"
DST="${1:-$HOME/index-tts/checkpoints}"
PY="${PY:-$(command -v python3 || command -v python || true)}"
[ -z "$PY" ] && { echo "需要 python3（用来多线程下模型）"; exit 1; }
TOOL="$(cd "$(dirname "$0")" && pwd)/fetch_model.py"
mkdir -p "$DST"

small=(config.yaml configuration.json feat1.pt feat2.pt multilingual_zh_ja_yue_char_del.tiktoken wav2vec2bert_stats.pt LICENSE README.md)
big=(codec.pth s2mel.pth gpt.pth)

for f in "${small[@]}"; do
  if [ -s "$DST/$f" ]; then echo "skip $f"; continue; fi
  echo "== $f"
  curl -sL --max-time 300 -o "$DST/$f" "$BASE/$f" || echo "ERR $f"
done

for f in "${big[@]}"; do
  echo "== $f"
  "$PY" -u "$TOOL" "$BASE/$f" "$DST/$f" 24 || echo "ERR $f"
done

echo "== done =="
du -sh "$DST"
