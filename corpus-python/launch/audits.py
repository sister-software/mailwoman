"""Running the training package's own audits on the volume's corpus, and committing the receipt.

    modal run -m launch.train_remote::audit_epoch_mixture --config-name <recipe>.yaml
    modal run -m launch.train_remote::census_opening_token --config-name <recipe>.yaml
    modal run -m launch.train_remote::audit_suffix_feed --config-name <recipe>.yaml

Each is a thin wrapper: the audit itself lives in `mailwoman_train.audits`, where it is unit-tested
and can run anywhere, and this supplies the volume, the CPU and the committed JSON path. They are
CPU-only by design — an audit that needed the GPU would be an audit nobody runs before a launch.

Pull a receipt with `modal volume get mailwoman-training /audits/<name>.json <local>`.
"""

from __future__ import annotations

from .app import VOL_MOUNT, app, training_image, vol

#: Where a committed receipt lands. Named once: a caller quoting a different directory writes a
#: receipt the next `modal volume get` cannot find.
AUDITS = f"{VOL_MOUNT}/audits"


def _config_path(config_name: str):
    """The volume's copy of a recipe, or a raise naming the path that is not there."""
    from pathlib import Path

    path = Path(f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/{config_name}")
    if not path.is_file():
        raise RuntimeError(f"Config not found: {path}")
    return path


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    timeout=7200,
    memory=16384,
)
def audit_epoch_mixture(config_name: str = "v4.3.3-suffix-boundary-base-60k.yaml", window: int = 100000):
    """Full-epoch source/country mixture audit against the volume corpus.

    Runs the loader over one row-limited epoch exactly as the trainer would sample it (seed =
    train.seed + 1). A recipe's configured ``required_corpus_receipts`` fail this function before a
    GPU run is launched, which is the point: the mixture is checkable without the spend.
    """
    import sys
    from pathlib import Path

    vol.reload()
    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")

    config_path = _config_path(config_name)

    from mailwoman_train.audits.epoch_mixture import CorpusReceiptError, run

    json_path = Path(f"{AUDITS}/epoch-mixture-{config_path.stem}.json")
    try:
        run(config_path, json_path=json_path, window=window)
    except CorpusReceiptError:
        vol.commit()
        raise
    vol.commit()
    print(f"\nAudit committed to volume: {json_path}")


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    timeout=7200,
    memory=16384,
)
def census_opening_token(config_name: str = "v5.6.0-bare-postcode-60k.yaml", draws: int = 0):
    """Count what a row's OPENING token teaches, at the draw level and again at the emitted level.

    Settles the ratio a bare-postcode arm rests on: how much of the mixture teaches "a leading digit
    group is a house number" against how much teaches "it is a postcode". An inherited ratio without
    its definition and its sampling level is not evidence, so this counts six nested definitions at
    both levels and lets the comparison be made on stated terms.

    Unlike `audit_epoch_mixture`, the emitted pass honours `augment_exclude_sources`, because the
    trainer does.
    """
    import sys
    from pathlib import Path

    vol.reload()
    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")

    config_path = _config_path(config_name)

    from mailwoman_train.audits.opening_token import run

    json_path = Path(f"{AUDITS}/opening-token-{config_path.stem}.json")
    run(config_path, json_path=json_path, draws=draws or None)
    vol.commit()
    print(f"\nCensus committed to volume: {json_path}")


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    timeout=7200,
    memory=16384,
)
def audit_suffix_feed(
    config_name: str = "v4.3.3-suffix-boundary-base-60k.yaml",
    relabel_lexicon: str = "/data/gazetteer/affix-relabel-lexicon-v2.json",
    rows: int = 250000,
    seed: int = 1569,
):
    """Terminal-only carrier audit over the volume feed.

    Classification always uses the v2 lexicon (it defines the name-prone classes); the RELABEL
    lexicon is the variable — pass v1 to reproduce the 2026-08-09 baseline (ordinary carriers
    ~22.1% correct), v2 to measure the positional-licensing fix.
    """
    import sys
    from pathlib import Path

    vol.reload()
    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")

    config_path = _config_path(config_name)

    from mailwoman_train.audits.suffix_feed import run

    relabel_path = Path(relabel_lexicon)
    json_path = Path(f"{AUDITS}/suffix-feed-{config_path.stem}-{relabel_path.stem}.json")
    run(
        config_path,
        classify_lexicon=Path(f"{VOL_MOUNT}/gazetteer/affix-relabel-lexicon-v2.json"),
        relabel_lexicon=relabel_path,
        rows=rows,
        seed=seed,
        json_path=json_path,
    )
    vol.commit()
    print(f"\nAudit committed to volume: {json_path}")
