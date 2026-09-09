#!/usr/bin/env bash
# Create/refresh the durable IPython venv used by `pythonImpl: 'ipykernel'`.
#
# The kernel runner does not bundle Python: it spawns whatever `pythonPath`
# points at. This script provisions a persistent venv with ipykernel at
# ~/.dsh/venvs/code-runtime-kernels-python (override with DSH_KERNEL_VENV),
# based on the device's `python3` (override with DSH_KERNEL_BASE_PYTHON).
# Point the plugin config at the venv's interpreter:
#   pythonPath: /Users/<you>/.dsh/venvs/code-runtime-kernels-python/bin/python
#   pythonImpl: 'ipykernel'
#
# Idempotent: safe to re-run after an OS/homebrew Python upgrade.
set -euo pipefail

VENV="${DSH_KERNEL_VENV:-$HOME/.dsh/venvs/code-runtime-kernels-python}"
BASE_PYTHON="${DSH_KERNEL_BASE_PYTHON:-python3}"

if [ ! -x "$VENV/bin/python" ]; then
  echo "creating venv at $VENV (base: $BASE_PYTHON)"
  "$BASE_PYTHON" -m venv "$VENV"
fi

echo "installing/upgrading ipykernel into $VENV"
"$VENV/bin/pip" install -q --upgrade ipykernel

"$VENV/bin/python" -c "import IPython, ipykernel, sys; print('ok:', sys.executable, 'IPython', IPython.__version__, '/ ipykernel', ipykernel.__version__)"
