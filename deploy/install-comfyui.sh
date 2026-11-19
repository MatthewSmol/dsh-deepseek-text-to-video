#!/usr/bin/env bash
# RU: Устанавливает ComfyUI + LTX-Video 2B distilled в отдельный каталог, без root и без Docker.
# EN: Installs ComfyUI + LTX-Video 2B distilled into a standalone directory, no root, no Docker.
set -euo pipefail

COMFY_COMMIT="${COMFY_COMMIT:-995456d0}"
TORCH_VERSION="2.11.0"
TORCHVISION_VERSION="0.26.0"
TORCHAUDIO_VERSION="2.11.0"
CUDA_INDEX="https://download.pytorch.org/whl/cu130"

DIR="${HOME}/comfyui"
PORT="8188"
CUDA_DEVICE="1"
MODELS_FROM=""
WITH_EXTRA="false"
NO_MODELS="false"
FORCE_PLUGIN_WORKFLOW="false"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'USAGE'
Install ComfyUI + LTX-Video 2B distilled (GGUF-free, fp8 checkpoint).

Usage: bash deploy/install-comfyui.sh [options]

Options:
  --dir PATH                 target directory (default: ~/comfyui)
  --models-from PATH         copy models from an existing ComfyUI models/ dir
                             instead of downloading (~10 GB)
  --with-extra               also download bf16 checkpoint and both VAEs (+7 GB)
  --no-models                skip model download entirely
  --cuda-device N            GPU index passed to ComfyUI (default: 1)
  --port N                   HTTP port (default: 8188)
  --force-plugin-workflow    overwrite $DSH_HOME/genvideo/workflow.json
  -h, --help                 show this help

After install:
  bash <comfyui-dir>/start-comfyui.sh
  open http://127.0.0.1:8188
USAGE
}

log()  { printf '[install] %s\n' "$*"; }
fail() { printf '[error] %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="${2:?--dir needs a value}"; shift 2 ;;
    --models-from) MODELS_FROM="${2:?--models-from needs a value}"; shift 2 ;;
    --with-extra) WITH_EXTRA="true"; shift ;;
    --no-models) NO_MODELS="true"; shift ;;
    --cuda-device) CUDA_DEVICE="${2:?--cuda-device needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --force-plugin-workflow) FORCE_PLUGIN_WORKFLOW="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1 (see --help)" ;;
  esac
done

[[ "$(uname -s)" == "Linux" ]] || fail "this script targets Linux/WSL2"
command -v git >/dev/null || fail "git is required"
command -v curl >/dev/null || fail "curl is required"

mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"

# RU: места должно хватить на venv (~9 ГБ) и модели (~10 или ~17 ГБ).
# EN: enough room for the venv (~9 GB) and models (~10 or ~17 GB).
NEED_GB=24
if [[ "$WITH_EXTRA" == "true" ]]; then NEED_GB=32; fi
if [[ "$NO_MODELS" == "true" ]]; then NEED_GB=12; fi
AVAIL_GB=$(df -Pk "$DIR" | awk 'NR==2 {print int($4/1024/1024)}')
if (( AVAIL_GB < NEED_GB )); then
  fail "not enough disk in $DIR: ${AVAIL_GB} GB free, need ${NEED_GB} GB"
fi

if ! command -v uv >/dev/null; then
  log "installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
  export PATH="${HOME}/.local/bin:${PATH}"
fi
command -v uv >/dev/null || fail "uv installation failed"

log "installing CPython 3.12 via uv"
uv python install 3.12 >/dev/null
PYTHON_BIN="$(uv python find 3.12)"

if [[ ! -d "$DIR/.git" ]]; then
  log "cloning ComfyUI into $DIR"
  git clone https://github.com/comfyanonymous/ComfyUI "$DIR"
fi
log "checking out $COMFY_COMMIT"
git -C "$DIR" fetch --all --tags --quiet || true
git -C "$DIR" checkout --quiet "$COMFY_COMMIT" || log "commit $COMFY_COMMIT not found, staying on current HEAD"

VENV="$DIR/venv"
if [[ ! -x "$VENV/bin/python" ]]; then
  log "creating venv"
  "$PYTHON_BIN" -m venv "$VENV"
fi

log "installing torch ${TORCH_VERSION}+cu130"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet --index-url "$CUDA_INDEX" \
  "torch==${TORCH_VERSION}" "torchvision==${TORCHVISION_VERSION}" "torchaudio==${TORCHAUDIO_VERSION}"

REQ_LOCK="$SCRIPT_DIR/requirements.lock"
[[ -f "$REQ_LOCK" ]] || fail "missing $REQ_LOCK"
TMP_REQ="$(mktemp)"
grep -viE '^(torch|torchvision|torchaudio)==' "$REQ_LOCK" > "$TMP_REQ" || true
log "installing ComfyUI requirements (locked)"
"$VENV/bin/pip" install --quiet -r "$TMP_REQ"
rm -f "$TMP_REQ"

download_models() {
  local manifest="$SCRIPT_DIR/models.tsv"
  [[ -f "$manifest" ]] || fail "missing $manifest"
  while IFS=$'\t' read -r rel url size sha group; do
    [[ -z "$rel" || "$rel" == \#* ]] && continue
    if [[ "$group" == "extra" && "$WITH_EXTRA" != "true" ]]; then
      continue
    fi
    local dst="$DIR/models/$rel"
    mkdir -p "$(dirname "$dst")"
    if [[ -f "$dst" ]]; then
      local have
      have=$(stat -c%s "$dst")
      if [[ "$have" == "$size" ]]; then
        log "skip (present): $rel"
        continue
      fi
    fi
    if [[ -n "$MODELS_FROM" ]]; then
      local src="$MODELS_FROM/$rel"
      [[ -f "$src" ]] || fail "missing $src"
      log "copy: $rel"
      cp --reflink=auto "$src" "$dst"
    else
      log "download: $rel ($(( size / 1024 / 1024 )) MB)"
      curl -L --fail --retry 5 --retry-delay 3 -C - -o "$dst" "$url"
    fi
    local actual
    actual=$(sha256sum "$dst" | awk '{print $1}')
    if [[ "$actual" != "$sha" ]]; then
      rm -f "$dst"
      fail "sha256 mismatch for $rel (expected $sha, got $actual)"
    fi
  done < "$manifest"
}

if [[ "$NO_MODELS" == "true" ]]; then
  log "skipping models (--no-models)"
else
  download_models
fi

# RU: KJNodes нужен для батчевого нейро-апскейла.
# EN: KJNodes is required for batched neural upscaling.
if [[ ! -d "$DIR/custom_nodes/ComfyUI-KJNodes" ]]; then
  git clone --depth 1 https://github.com/kijai/ComfyUI-KJNodes "$DIR/custom_nodes/ComfyUI-KJNodes"
  "$VENV/bin/pip" install -r "$DIR/custom_nodes/ComfyUI-KJNodes/requirements.txt"
fi
mkdir -p "$DIR/user/default/workflows"
if [[ -d "$SCRIPT_DIR/ui-workflows" ]]; then
  log "installing UI workflows"
  cp "$SCRIPT_DIR/ui-workflows/"*.json "$DIR/user/default/workflows/"
fi

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_WF="$DSH_HOME_DIR/genvideo/workflow.json"
if [[ -f "$PLUGIN_WF" && "$FORCE_PLUGIN_WORKFLOW" != "true" ]]; then
  log "keeping existing $PLUGIN_WF (use --force-plugin-workflow to replace)"
else
  mkdir -p "$(dirname "$PLUGIN_WF")"
  cp "$SCRIPT_DIR/genvideo-workflow.json" "$PLUGIN_WF"
  log "installed plugin workflow: $PLUGIN_WF"
fi

cat > "$DIR/start-comfyui.sh" <<START
#!/usr/bin/env bash
set -euo pipefail
exec "$VENV/bin/python" "$DIR/main.py" \\
  --listen 127.0.0.1 --port ${PORT} --cuda-device ${CUDA_DEVICE} --preview-method none "\$@"
START
chmod +x "$DIR/start-comfyui.sh"

cat <<DONE

ComfyUI + LTX installed.

  start:  bash $DIR/start-comfyui.sh
  url:    http://127.0.0.1:${PORT}
  models: $DIR/models
  gpu:    --cuda-device ${CUDA_DEVICE}

Plugin: set ComfyUI URL in GenVideo settings to http://127.0.0.1:${PORT}
DONE
