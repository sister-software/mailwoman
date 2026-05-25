---
sidebar_position: 15
title: Training environment — playpen container setup
---

# Training environment

:::tip Audience

🧪 **Operator documentation.** For contributors provisioning GPU training environments. If you want to use Mailwoman, see [Getting started](/docs/getting-started).

:::
---

# Training environment — playpen container setup

How to bring a fresh playpen container to the point where it can train a classifier or run a tokenizer build. Captures the gap that bit v0.5.0 Thread C-train.

## What you start with

A `playpen-mailwoman` container has:

- Ubuntu 24.04, Node 24 + Yarn 4, the mailwoman repo cloned at `/home/agent/workspace/mailwoman/`
- Python 3.12 system interpreter, `uv` available
- `/data/corpus/...` mounted (corpus shards, ~30 GB)
- `/data/models/...` mounted (tokenizer weights, model checkpoints)
- **No GPU device passthrough**
- **No `~/training-venv`**

The first two facts together are the blocker. Tokenizer training (A0, A1) needed neither — it's pure CPU SentencePiece. Classifier training (C-train) needs both.

## Step 1 — GPU passthrough

From the host (this is operator-side, not in-container):

```bash
incus config device add <container> gpu gpu
incus config device add <container> kfd unix-char source=/dev/kfd
```

The first line passes through `/dev/dri/card0` + `/dev/dri/renderD128` (graphics + render nodes). The second adds `/dev/kfd` (AMD compute device — ROCm's entry point). Both are live changes; no container restart needed.

Verify in-container:

```bash
ls -la /dev/kfd /dev/dri/
```

Expect to see `kfd`, `card0`, `renderD128` all present with `crw-rw-...` permissions.

## Step 2 — Bootstrap `~/training-venv`

The mailwoman `corpus-python` package splits dependencies — heavy ML deps (PyTorch, Transformers, Datasets, ONNX) live under the `[train]` extras so tokenizer-only work doesn't pull them. Make a dedicated venv:

```bash
uv venv ~/training-venv --python=3.12
source ~/training-venv/bin/activate
```

### Step 2a — Install PyTorch with the ROCm wheel FIRST

Critical ordering: install the ROCm-built PyTorch wheel before `pip install -e .[train]`. The generic resolver picks CUDA wheels by default on x86_64 even though they won't run on AMD GPUs.

For the lab's Radeon 780M (gfx1103, RDNA 3 iGPU):

```bash
pip install torch --index-url https://download.pytorch.org/whl/rocm6.2
```

Download is ~3 GB. Takes 5-10 min on home upstream.

### Step 2b — Install corpus-python + train extras

```bash
cd ~/workspace/mailwoman/corpus-python
pip install -e .[train]
```

This adds `transformers>=4.41`, `datasets>=2.19`, `onnx>=1.16`, `onnxruntime>=1.18`, `tqdm` on top of the always-installed `sentencepiece`, `pyarrow`, `pyyaml`, `numpy`. Another ~1 GB. ~3-5 min.

## Step 3 — Verify GPU detected

```bash
python -c '
import torch
print("cuda:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("device:", torch.cuda.get_device_name(0))
    print("hip:", torch.version.hip)
'
```

Expected output on the lab hardware:

```
cuda: True
device: AMD Radeon Graphics
hip: 6.2.41133-XXXXXXXX
```

`torch.cuda.is_available()` returns `True` on AMD because PyTorch's ROCm build exposes the AMD GPU under the same `torch.cuda.*` API. The HIP version confirms you got the ROCm wheel and not the CUDA wheel.

## Step 4 — Runtime override for gfx1103

The Radeon 780M reports itself as `gfx1103` but ROCm's compute kernels target `gfx1100`. Set this env var before any training command:

```bash
export HSA_OVERRIDE_GFX_VERSION=11.0.0
```

Without the override, kernel launches will fail with cryptic GPU errors. Persist it in `~/.bashrc` or prefix every training invocation.

## Step 5 — Other env quirks

- **`hipBLASLt unsupported`**: PyTorch emits a `UserWarning: Attempting to use hipBLASLt on an unsupported architecture! Overriding blas backend to hipblas` on every Linear layer call. Harmless — the `hipblas` fallback works correctly on gfx1103. Future PyTorch versions may stop logging this.
- **`amdgpu.ids: No such file or directory`**: also harmless. The file is shipped with `mesa-amdgpu-vulkan-drivers` which isn't installed in the playpen base image. Nothing fails as a result.
- **Math SDPA**: per [the lab GPU notes](https://github.com/sister-software/mailwoman/blob/main/docs/articles/concepts/training-pipeline.md), set `torch.backends.cuda.enable_flash_sdp(False)` and use `math` SDPA backend if attention kernels misbehave. The current corpus-python configs already do this.

## Cost summary

| Step                      | Time        | Notes                           |
| ------------------------- | ----------- | ------------------------------- |
| GPU passthrough           | < 1 min     | Host-side, no container restart |
| `uv venv`                 | < 5 sec     |                                 |
| ROCm PyTorch wheel        | 5-10 min    | ~3 GB download                  |
| `pip install -e .[train]` | 3-5 min     | ~1 GB                           |
| Verify GPU                | < 5 sec     |                                 |
| **Total**                 | **~15 min** |                                 |

## Why this isn't pre-baked

Two reasons the mailwoman container template doesn't ship a training-venv:

1. **Image size**: torch + transformers + onnxruntime add ~5 GB to the container image. Multiplied across every playpen container (most of which never train), this is wasteful.
2. **Use-case split**: tokenizer training and corpus utility scripts use only the lighter `sentencepiece` + `pyarrow` deps. They don't want or need torch. Splitting via `[train]` extras keeps the common case small.

The right time to bake it in is when classifier-training becomes a routine container spawn (multiple times per week). Until then the 15-min one-time setup is cheaper than the per-container image bloat.

## See also

- [`VERDICT_SMOKES.md`](./VERDICT_SMOKES.md) — what to run once the environment is up
- [PHASE_2_training.md](../phases/PHASE_2_training.md) — the training loop's expected configuration
- [`tokenizer-a0-baseline.md`](./tokenizer-a0-baseline.md) — the lighter-weight alternative path (CPU-only, no torch needed)
