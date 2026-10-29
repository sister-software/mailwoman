"""This command runs one selected splice: the Modal half of `launch/splices.py`.

    modal run -m launch.train_remote::mean_init --splice ptro

Thin by design, the way `syncs.py` is thin over `corpora.py`. The values live in `splices.py`.
That module imports no Modal, so tests can run without the SDK. This module supplies the volume, image and
the refusal when a result does not match what the table recorded.
"""

from __future__ import annotations

from pathlib import Path

from .app import VOL_MOUNT, app, training_image, vol
from .splices import SPLICES, TOKENIZERS


def mean_init_embeddings(
    checkpoint_dir: Path, base_tokenizer: Path, spliced_tokenizer: Path, out_dir: Path
) -> tuple[int, int]:
    """Expand ``checkpoint_dir``'s token embeddings to the spliced vocabulary and write the result to ``out_dir``.

    Each new row is the mean of the base tokenizer's piece embeddings for the new piece's surface, or the mean of every
    row when the surface has no piece inside the old vocabulary. Only the token embeddings and the config's
    ``vocab_size`` change. The encoder, the classifier and every head stay as they were. Returns (old, new) sizes.
    The checkpoint is a PyTorch state dict, so this step runs in the training image. The ONNX form of the same
    expansion is ``packages/mtf/tools/tokenizer/splice.run.ts onnx-mean-init``.
    """
    import json

    import torch

    from mailwoman_train.tokenizer import Tokenizer

    spliced = Tokenizer(spliced_tokenizer)
    new_vocab = spliced.vocab_size
    state = torch.load(checkpoint_dir / "pytorch_model.bin", weights_only=True, map_location="cpu")
    embeddings = state["token_embeddings.weight"]
    old_vocab, hidden = embeddings.shape
    if new_vocab < old_vocab:
        raise ValueError(f"spliced vocab {new_vocab} < checkpoint vocab {old_vocab}; wrong tokenizer?")

    base = Tokenizer(base_tokenizer)
    overall = embeddings.mean(0)
    rows = torch.empty(new_vocab - old_vocab, hidden)
    for index in range(old_vocab, new_vocab):
        surface = spliced.id_to_piece(index).replace("▁", " ")
        constituents = [p.piece_id for p in base.encode_with_spans(surface) if p.piece_id < old_vocab]
        rows[index - old_vocab] = embeddings[torch.tensor(constituents)].mean(0) if constituents else overall
    state["token_embeddings.weight"] = torch.cat([embeddings, rows], 0)

    out_dir.mkdir(parents=True, exist_ok=True)
    torch.save(state, out_dir / "pytorch_model.bin")
    config = json.loads((checkpoint_dir / "config.json").read_text(encoding="utf-8"))
    config["vocab_size"] = new_vocab
    (out_dir / "config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return old_vocab, new_vocab


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    timeout=1200,
)
def mean_init(splice: str = "") -> None:
    """Expand a selected splice's checkpoint onto its wider tokenizer and commit the result.

    Mean-init is FVT: each new piece's embedding row starts as the mean of the rows its old-tokenizer
    constituents had. Encoder and heads are untouched.
    """
    import sys

    entry = SPLICES.get(splice)
    if entry is None:
        raise RuntimeError(f"no splice named {splice!r}. Known: {', '.join(sorted(SPLICES))}")

    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")

    vol.reload()
    destination = Path(f"{VOL_MOUNT}/{entry.destination}")
    print(f"{splice}: {entry.adds}")
    old_size, new_size = mean_init_embeddings(
        Path(f"{VOL_MOUNT}/{entry.checkpoint}"),
        Path(f"{VOL_MOUNT}/{TOKENIZERS}/{entry.from_tokenizer}/tokenizer.model"),
        Path(f"{VOL_MOUNT}/{TOKENIZERS}/{entry.to_tokenizer}/tokenizer.model"),
        destination,
    )
    vol.commit()

    print(f"mean-init done: {old_size} -> {new_size} rows; {destination} committed")
    for name in ("pytorch_model.bin", "config.json"):
        present = (destination / name).is_file()
        print(f"  {name} present: {present}")
        if not present:
            raise RuntimeError(f"{splice}: {destination / name} was not written; the fine-tune has no base")

    if entry.vocabulary is not None and (old_size, new_size) != entry.vocabulary:
        raise RuntimeError(
            f"{splice}: expected {entry.vocabulary[0]} -> {entry.vocabulary[1]} rows, got {old_size} -> {new_size}. "
            "Either the checkpoint or a tokenizer is not the one this splice was measured against."
        )
