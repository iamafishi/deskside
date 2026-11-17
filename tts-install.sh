#!/usr/bin/env bash
# 安装本地 IndexTTS-2.5 推理环境（默认 ~/index-tts，可用 TTS_DIR 覆盖）
# 用法：bash tts-install.sh            # 装到 ~/index-tts
#       TTS_DIR=/d/tts bash tts-install.sh
set -u
ROOT="${TTS_DIR:-$HOME/index-tts}"
SRC="$ROOT/index-tts"
LOG="$ROOT/install.log"
mkdir -p "$ROOT"
exec >>"$LOG" 2>&1
echo "===== $(date '+%F %T') start ====="

step() { echo; echo "---- $* ----"; }

command -v uv >/dev/null 2>&1 || { echo "错误：需要 uv（https://docs.astral.sh/uv/）"; exit 1; }

step "uv python 3.11"
uv python install 3.11 || echo "WARN python install failed"

step "clone"
if [ ! -d "$SRC/.git" ]; then
  rm -rf "$SRC"
  # 不继承全局代理（离线的代理配置会让 clone 卡住）；需要代理时自己设 https_proxy
  GITCLONE="git -c http.proxy= -c https.proxy= clone --depth 1"
  $GITCLONE https://github.com/index-tts/index-tts.git "$SRC" \
    || $GITCLONE https://gitee.com/mirrors_index-tts/index-tts.git "$SRC" \
    || $GITCLONE https://ghfast.top/https://github.com/index-tts/index-tts.git "$SRC" \
    || echo "ERR clone failed"
else
  echo "already cloned"
fi
ls "$SRC" | head -20

step "venv + deps"
cd "$SRC" || exit 1
export UV_PYTHON_DOWNLOADS=never
PY311="$(uv python find --no-project 3.11 2>/dev/null)"
echo "PY311=$PY311"
rm -rf .venv
uv venv --python "$PY311" .venv || echo "ERR venv failed"
export VIRTUAL_ENV="$SRC/.venv"
VPY="$SRC/.venv/Scripts/python.exe"
ls -la "$VPY"
# 用 uv pip 装（不用 uv sync：sync 会想重新下载 python 运行时）
uv pip install --python "$VPY" -e . || echo "ERR deps failed"

step "torch cu128 (Blackwell sm_120)"
uv pip install --python "$VPY" --upgrade torch torchaudio \
  --index-url https://download.pytorch.org/whl/cu128 || echo "ERR torch failed"

step "check torch"
"$SRC/.venv/Scripts/python.exe" -c "import torch;print('torch',torch.__version__);print('cuda',torch.cuda.is_available());print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'no gpu')" \
  || echo "ERR torch check failed"

step "download model (modelscope)"
uv pip install --python "$SRC/.venv/Scripts/python.exe" modelscope || echo "WARN modelscope install failed"
"$SRC/.venv/Scripts/python.exe" -c "
from modelscope import snapshot_download
p = snapshot_download('IndexTeam/IndexTTS-2.5', local_dir=r'$SRC/checkpoints')
print('model at', p)
" || echo "ERR model download failed"

step "done"
du -sh "$SRC/checkpoints" 2>/dev/null
du -sh "$SRC/.venv" 2>/dev/null
echo "===== $(date '+%F %T') end ====="
