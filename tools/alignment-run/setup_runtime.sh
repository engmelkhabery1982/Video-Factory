#!/bin/bash
# Dedicated vf-align runtime. Does not download model weights and does not read the recording.
set -eu
export DEBIAN_FRONTEND=noninteractive

STAGE="${1:-}"
ROOT=/opt/vf-align
UV_VERSION=0.8.22
UV_URL="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz"
UV_SUM_URL="${UV_URL}.sha256"
UV_BIN="${ROOT}/bin/uv"
PY_DIR="${ROOT}/python"
VENV="${ROOT}/venv-3.11.11"
CPU_INDEX="https://download.pytorch.org/whl/cpu"
FS2_INDEX="https://fair.pkg.atmeta.com/fairseq2/whl/pt2.8.0/cpu"

mkdir -p "${ROOT}/bin" "${ROOT}/src" "${PY_DIR}"
export UV_PYTHON_INSTALL_DIR="${PY_DIR}"

python_ok() {
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info[:3] == (3, 11, 11) else 1)'
}

install_uv() {
  if [ -x "${UV_BIN}" ] && "${UV_BIN}" --version | grep -qx "uv ${UV_VERSION}"; then
    echo "uv_reused=${UV_VERSION}"
    return 0
  fi
  tmp="$(mktemp -d)"
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 2 -o "${tmp}/uv.tar.gz" "${UV_URL}"
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 2 -o "${tmp}/uv.sha256" "${UV_SUM_URL}"
  expected="$(awk '{print $1}' "${tmp}/uv.sha256")"
  actual="$(sha256sum "${tmp}/uv.tar.gz" | awk '{print $1}')"
  if [ -z "${expected}" ] || [ "${expected}" != "${actual}" ]; then
    echo "BLOCKER=uv_sha256_mismatch expected=${expected} actual=${actual}" >&2
    exit 2
  fi
  tar -xzf "${tmp}/uv.tar.gz" -C "${tmp}"
  found="$(find "${tmp}" -type f -name uv -print | head -n 1)"
  if [ -z "${found}" ]; then
    echo "BLOCKER=uv_binary_missing_from_archive" >&2
    exit 2
  fi
  install -m 0755 "${found}" "${UV_BIN}"
  if ! "${UV_BIN}" --version | grep -qx "uv ${UV_VERSION}"; then
    echo "BLOCKER=uv_version_mismatch got=$(${UV_BIN} --version)" >&2
    exit 2
  fi
  echo "uv_installed=${UV_VERSION}"
}

ensure_python() {
  if [ -x "${VENV}/bin/python" ]; then
    if python_ok "${VENV}/bin/python"; then
      echo "python_reused=3.11.11 venv=${VENV}"
      return 0
    fi
    echo "BLOCKER=venv_python_mismatch path=${VENV} version=$(${VENV}/bin/python -V 2>&1)" >&2
    echo "The existing virtual environment was not deleted." >&2
    exit 2
  fi
  if [ -e "${VENV}" ]; then
    echo "BLOCKER=venv_path_exists_but_has_no_python path=${VENV}" >&2
    echo "That path was not deleted." >&2
    exit 2
  fi
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl libsndfile1
  install_uv
  "${UV_BIN}" python install 3.11.11
  py="$("${UV_BIN}" python find 3.11.11)"
  python_ok "${py}"
  "${py}" -m venv "${VENV}"
  python_ok "${VENV}/bin/python"
  echo "python_ok=$(${VENV}/bin/python -V)"
}

runtime_ready() {
  "${VENV}/bin/python" - << 'PY'
import importlib.metadata
import json
from pathlib import Path
import torch
import torchaudio
import fairseq2
import omnilingual_asr
from fairseq2.models.wav2vec2.asr import get_wav2vec2_asr_model_hub

def version_of(*names):
    for name in names:
        try:
            return importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            continue
    return None

def wheel_url(name):
    dist = importlib.metadata.distribution(name)
    for item in dist.files or []:
        if item.name == "direct_url.json":
            return json.loads(Path(dist.locate_file(item)).read_text()).get("url", "")
    return ""

if not torch.__version__.startswith("2.8.0+cpu") or torch.cuda.is_available():
    raise SystemExit(f"BLOCKER=torch_is_not_cpu_build:{torch.__version__}")
if not torchaudio.__version__.startswith("2.8.0"):
    raise SystemExit(f"BLOCKER=torchaudio_version:{torchaudio.__version__}")
if version_of("fairseq2") not in {"0.6", "0.6.0"}:
    raise SystemExit(f"BLOCKER=fairseq2_version:{version_of('fairseq2')}")
if version_of("omnilingual-asr", "omnilingual_asr") != "0.2.0":
    raise SystemExit(f"BLOCKER=omnilingual_version:{version_of('omnilingual-asr', 'omnilingual_asr')}")
url = wheel_url("fairseq2n")
if "pt2.8.0/cpu" not in url or "cu128" in url or "cu126" in url:
    raise SystemExit(f"BLOCKER=fairseq2n_not_from_cpu_index:{url}")
hub = get_wav2vec2_asr_model_hub()
if "300m_v2" not in hub.get_archs():
    omnilingual_asr.setup_fairseq2_extension(__import__("fairseq2.runtime.dependency", fromlist=["get_dependency_resolver"]).get_dependency_resolver())
    hub = get_wav2vec2_asr_model_hub()
if "300m_v2" not in hub.get_archs():
    raise SystemExit("BLOCKER=300m_v2_arch_missing")
print("runtime_ready", torch.__version__, "fairseq2", fairseq2.__version__ if hasattr(fairseq2, "__version__") else version_of("fairseq2"))
PY
}

cpu_wheel_url() {
  name="$1"
  page="$(curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 2 "${FS2_INDEX}${name}/" || true)"
  if [ -z "${page}" ]; then
    page="$(curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 2 "${FS2_INDEX}" || true)"
  fi
  href="$(printf '%s\n' "${page}" | grep -oE "href=['\"][^'\"]*${name}-[^'\"]*cp311[^'\"]*manylinux[^'\"]*\\.whl" | head -n 1 | sed -E "s/^href=['\"]//; s/['\"].*$//")"
  if [ -z "${href}" ]; then
    printf '%s\n' "${page}" | head -n 40 >&2
    echo "BLOCKER=cpu_index_missing_${name}_cp311_wheel index=${FS2_INDEX}" >&2
    exit 2
  fi
  case "${href}" in
    https://*) printf '%s\n' "${href}" ;;
    /*) printf 'https://fair.pkg.atmeta.com%s\n' "${href}" ;;
    *) printf '%s%s\n' "${FS2_INDEX}${name}/" "${href#./}" ;;
  esac
}

ensure_runtime() {
  python_ok "${VENV}/bin/python"
  if runtime_ready; then
    echo "runtime_reused=yes"
    return 0
  fi
  "${VENV}/bin/python" -m pip install --upgrade pip
  "${VENV}/bin/python" -m pip install 'torch==2.8.0+cpu' 'torchaudio==2.8.0+cpu' --index-url "${CPU_INDEX}"
  fairseq2n_url="$(cpu_wheel_url fairseq2n)"
  case "${fairseq2n_url}" in
    *pt2.8.0/cpu*) ;;
    *)
      echo "BLOCKER=fairseq2n_url_not_cpu_index ${fairseq2n_url}" >&2
      exit 2
      ;;
  esac
  "${VENV}/bin/python" -m pip install --no-deps 'fairseq2==0.6'
  "${VENV}/bin/python" -m pip install --no-cache-dir --no-deps "${fairseq2n_url}"
  "${VENV}/bin/python" -m pip install \
    'editdistance~=0.8' \
    'huggingface_hub~=0.32' \
    'importlib_metadata~=7.0' \
    'importlib_resources~=6.4' \
    'mypy-extensions~=1.0' \
    'numpy~=1.23' \
    'packaging~=24.1' \
    'psutil~=5.9' \
    'ruamel.yaml~=0.18' \
    'rich~=13.7' \
    'sacrebleu~=2.4' \
    'safetensors~=0.6' \
    'tiktoken~=0.7' \
    'torcheval~=0.0.6' \
    'tqdm~=4.62' \
    'typing_extensions~=4.12' \
    'blobfile~=3.0.0'
  "${VENV}/bin/python" -m pip install 'omnilingual-asr==0.2.0' --no-deps
  "${VENV}/bin/python" -m pip install 'pyarrow>=20' numba pandas numpy 'polars>=1.29' retrying xxhash
  if ! "${VENV}/bin/python" -m pip install kenlm; then
    echo "kenlm_install_failed=continuing_only_if_import_does_not_need_it" >&2
  fi
  runtime_ready
  echo "runtime_installed=cpu-torch-2.8.0 fairseq2-0.6 fairseq2n=${fairseq2n_url}"
}

case "${STAGE}" in
  ensure-python) ensure_python ;;
  ensure-runtime) ensure_runtime ;;
  *)
    echo "BLOCKER=unknown_setup_stage" >&2
    exit 2
    ;;
esac
