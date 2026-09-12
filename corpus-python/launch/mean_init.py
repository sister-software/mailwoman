"""Running one named splice: the Modal half of `launch/splices.py`.

    modal run -m launch.train_remote::mean_init --splice ptro

Thin by design, the way `syncs.py` is thin over `corpora.py`. The values live in `splices.py`, which
imports no Modal and is therefore testable without the SDK; this supplies the volume, the image, and
the refusal when a result does not match what the table recorded.
"""

from __future__ import annotations

from .app import VOL_MOUNT, app, training_image, vol
from .splices import SPLICES, TOKENIZERS


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    timeout=1200,
)
def mean_init(splice: str = "") -> None:
    """Expand one named splice's checkpoint onto its wider tokenizer, and commit the result.

    Mean-init is FVT: each new piece's embedding row starts as the mean of the rows its old-tokenizer
    constituents had. Encoder and heads are untouched.
    """
    import sys
    from pathlib import Path

    entry = SPLICES.get(splice)
    if entry is None:
        raise RuntimeError(f"no splice named {splice!r}. Known: {', '.join(sorted(SPLICES))}")

    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")
    from mailwoman_train.tokenizer.splice import mean_init_embeddings

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
