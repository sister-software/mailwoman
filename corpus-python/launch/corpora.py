"""What each corpus version stages onto the volume, as data.

One row per version. A new version is a row here, not a new Modal function — the variation between
versions is which directories move and which files must land afterwards, and that is a manifest
rather than code. `launch/plan.py` turns a row into commands; `launch/sync.py` runs them.

A version name is written ONCE per transfer. `corpus("v0.12.0-nz")` derives both the bucket path
and the volume path, because the name otherwise appears four times in one pair and a corpus version
ends up existing only as a substring of two strings nobody can enumerate. `corpus_versions()` reads
them back off the table for exactly that reason.

The three layouts differ by when a version was built, not by anything about its contents, so each
row names which one it uses:

    NESTED   corpus/<v>/corpus-<v>/  ->  corpus/versioned/<v>/corpus-<v>/   (22 transfers)
    FLAT     corpus/<v>/             ->  corpus/versioned/<v>/              (21)
    WRAPPED  corpus/<v>/             ->  corpus/versioned/<v>/corpus-<v>/   (12)

`mirror` is a directory that lands at the same path (68), `file_into` a single file into a
directory (13 into its own, 1 elsewhere). Those six shapes cover all 137 transfers.

`checks` are the paths the sync verifies after copying. They matter because rclone EXITS 0 WHEN THE
SOURCE PREFIX IS EMPTY: without a check, a version whose R2 prefix was never uploaded syncs
"successfully" and the training job fails much later on a missing parquet part, with nothing
pointing back at the sync.
"""

from __future__ import annotations

from .plan import (
    FLAT,
    PACKAGE_AND_CONFIGS,
    STEADY,
    WRAPPED,
    CorpusVersion,
    corpus,
    file_into,
    mirror,
)

#: Keyed by the name that followed `sync_` on the function this replaces, so an operator who knows
#: `sync_v8cjk_kr` finds `v8cjk_kr`.
CORPUS_VERSIONS: dict[str, CorpusVersion] = {
    "assets": CorpusVersion(
        copies=(),
    ),
    "jp_full": CorpusVersion(
        copies=(
            mirror("corpus-python/src/"),
            corpus("v8-jp-full-2026-08-04", FLAT),
            file_into("corpus/v8-jp-probe/jp-muni-centroids.json", directory="corpus/versioned/v8-jp-probe/"),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v8-jp-full-2k.yaml",
            "corpus-python/src/mailwoman_train/configs/v8-jp-full.yaml",
            "corpus/versioned/v8-jp-full-2026-08-04/build-report.json",
            "corpus/versioned/v8-jp-full-2026-08-04/char-vocab-jp-full.json",
            "corpus/versioned/v8-jp-full-2026-08-04/jp-board.jsonl",
            "corpus/versioned/v8-jp-full-2026-08-04/train/part-0000.parquet",
            "corpus/versioned/v8-jp-full-2026-08-04/train/part-0007.parquet",
            "corpus/versioned/v8-jp-full-2026-08-04/val/part-0000.parquet",
            "corpus/versioned/v8-jp-probe/jp-muni-centroids.json",
        ),
    ),
    "jp_probe": CorpusVersion(
        copies=(
            mirror("corpus-python/src/"),
            corpus("v8-jp-probe", FLAT),
            corpus("v8-leg2", FLAT),
            file_into("gazetteer/locality-surface-lexicon-v7.json"),
            corpus("v0.15.0-venue", FLAT),
            file_into("eval/fixtures/overture-fragments-de.jsonl"),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v8-jp-probe.yaml",
            "corpus-python/src/mailwoman_train/configs/v8-leg2-charword.yaml",
            "corpus-python/src/mailwoman_train/configs/v8-leg2-sp.yaml",
            "corpus/versioned/v8-jp-probe/char-vocab-jp-v1.json",
            "corpus/versioned/v8-jp-probe/jp-probe-board.jsonl",
            "corpus/versioned/v8-jp-probe/train/part-0000.parquet",
            "corpus/versioned/v8-jp-probe/val/part-0000.parquet",
            "corpus/versioned/v8-leg2/char-vocab-latin-v1.json",
        ),
    ),
    "substrate_repairs": CorpusVersion(
        copies=(
            mirror("corpus-python/src/"),
            file_into("gazetteer/affix-relabel-lexicon-v2.json"),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/audits/epoch_mixture/__init__.py",
            "corpus-python/src/mailwoman_train/configs/v4.3.3-cooldown46k.yaml",
            "corpus-python/src/mailwoman_train/data/loader/__init__.py",
            "corpus-python/src/mailwoman_train/data/relabel.py",
            "corpus-python/src/mailwoman_train/optim/schedules.py",
            "corpus-python/src/mailwoman_train/train/checkpoint.py",
            "gazetteer/affix-relabel-lexicon-v2.json",
        ),
    ),
    "v050": CorpusVersion(
        copies=(
            corpus("v0.5.0"),
            mirror("corpus-python/src/"),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.4.0-charoffset.yaml",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train",
        ),
    ),
    "v420_batch": CorpusVersion(
        copies=(
            mirror("corpus-python/src/"),
            corpus("v0.17.0-batch", WRAPPED),
            file_into("anchor/pilot-anchor-lookup-v2-2026-08-05.json"),
        ),
        checks=(
            "anchor/pilot-anchor-lookup-v2-2026-08-05.json",
            "corpus-python/src/mailwoman_train/configs/v4.2.0-base-anchor-v2-2k.yaml",
            "corpus-python/src/mailwoman_train/configs/v4.2.0-base-anchor-v2.yaml",
            "corpus/versioned/v0.15.0-venue/corpus-v0.15.0-venue/train/part-house-venue.parquet",
            "corpus/versioned/v0.17.0-batch/corpus-v0.17.0-batch/MANIFEST.json",
            "corpus/versioned/v0.17.0-batch/corpus-v0.17.0-batch/train/part-gb.parquet",
            "corpus/versioned/v0.17.0-batch/corpus-v0.17.0-batch/train/part-sub-venue.parquet",
        ),
    ),
    "v431_suffix_boundary": CorpusVersion(
        copies=(
            mirror("corpus-python/src/"),
            corpus("v0.18.1-suffix-boundary", WRAPPED),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v4.3.1-suffix-boundary-target-dose-8k.yaml",
            "corpus/versioned/v0.17.0-batch/corpus-v0.17.0-batch/train/part-sub-venue.parquet",
            "corpus/versioned/v0.18.1-suffix-boundary/corpus-v0.18.1-suffix-boundary/MANIFEST.json",
            "corpus/versioned/v0.18.1-suffix-boundary/corpus-v0.18.1-suffix-boundary/train/part-suffix-boundary.parquet",
            "models/tokenizer/v0.9.0-multisplice/tokenizer.model",
            "output-v420-base-anchor-v2-s42/checkpoints/step-060000/pytorch_model.bin",
        ),
    ),
    "v440": CorpusVersion(
        copies=(
            mirror("corpus-python/src/"),
            corpus("v0.19.0-suffix-boundary-v2", WRAPPED),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v4.4.0-suffix-boundary-v2-base-60k.yaml",
            "corpus-python/src/mailwoman_train/data/loader/__init__.py",
            "corpus/versioned/v0.17.0-batch/corpus-v0.17.0-batch/train/part-sub-venue.parquet",
            "corpus/versioned/v0.19.0-suffix-boundary-v2/corpus-v0.19.0-suffix-boundary-v2/MANIFEST.json",
            "corpus/versioned/v0.19.0-suffix-boundary-v2/corpus-v0.19.0-suffix-boundary-v2/train/part-suffix-boundary-v2.parquet",
            "gazetteer/affix-relabel-lexicon-v2.json",
            "models/tokenizer/v0.9.0-multisplice/tokenizer.model",
        ),
    ),
    "v450": CorpusVersion(
        copies=(
            mirror("corpus-python/src/"),
            corpus("v0.20.0-psc-frsurfaces", WRAPPED),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v4.5.0-psc-frsurfaces-2k.yaml",
            "corpus/versioned/v0.17.0-batch/corpus-v0.17.0-batch/train/part-sub-venue.parquet",
            "corpus/versioned/v0.20.0-psc-frsurfaces/corpus-v0.20.0-psc-frsurfaces/MANIFEST.json",
            "corpus/versioned/v0.20.0-psc-frsurfaces/corpus-v0.20.0-psc-frsurfaces/train/part-cz-pcfirst-v20.parquet",
            "corpus/versioned/v0.20.0-psc-frsurfaces/corpus-v0.20.0-psc-frsurfaces/train/part-fr-bare-street-v20.parquet",
            "models/tokenizer/v0.9.0-multisplice/tokenizer.model",
            "output-v440-suffix-boundary-v2-s42/checkpoints/step-060000/fisher-diag-v1.npz",
            "output-v440-suffix-boundary-v2-s42/checkpoints/step-060000/pytorch_model.bin",
        ),
    ),
    "v451": CorpusVersion(
        copies=(
            mirror("corpus-python/src/"),
            corpus("v0.21.0-psc-frsurfaces-v2", WRAPPED),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v4.5.1-psc-frsurfaces-2k.yaml",
            "corpus/versioned/v0.17.0-batch/corpus-v0.17.0-batch/train/part-sub-venue.parquet",
            "corpus/versioned/v0.21.0-psc-frsurfaces-v2/corpus-v0.21.0-psc-frsurfaces-v2/MANIFEST.json",
            "corpus/versioned/v0.21.0-psc-frsurfaces-v2/corpus-v0.21.0-psc-frsurfaces-v2/train/part-cz-pcfirst-v21.parquet",
            "corpus/versioned/v0.21.0-psc-frsurfaces-v2/corpus-v0.21.0-psc-frsurfaces-v2/train/part-fr-bare-street-v21.parquet",
            "models/tokenizer/v0.9.0-multisplice/tokenizer.model",
            "output-v440-suffix-boundary-v2-s42/checkpoints/step-060000/fisher-diag-v1.npz",
            "output-v440-suffix-boundary-v2-s42/checkpoints/step-060000/pytorch_model.bin",
        ),
    ),
    "v452": CorpusVersion(
        copies=(
            mirror("corpus-python/src/"),
            corpus("v0.22.0-psc-frsurfaces-v3", WRAPPED),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v4.5.2-psc-frsurfaces-2k.yaml",
            "corpus/versioned/v0.17.0-batch/corpus-v0.17.0-batch/train/part-sub-venue.parquet",
            "corpus/versioned/v0.22.0-psc-frsurfaces-v3/corpus-v0.22.0-psc-frsurfaces-v3/MANIFEST.json",
            "corpus/versioned/v0.22.0-psc-frsurfaces-v3/corpus-v0.22.0-psc-frsurfaces-v3/train/part-cz-pcfirst-v21.parquet",
            "corpus/versioned/v0.22.0-psc-frsurfaces-v3/corpus-v0.22.0-psc-frsurfaces-v3/train/part-fr-bare-street-v22.parquet",
            "models/tokenizer/v0.9.0-multisplice/tokenizer.model",
            "output-v440-suffix-boundary-v2-s42/checkpoints/step-060000/fisher-diag-v1.npz",
            "output-v440-suffix-boundary-v2-s42/checkpoints/step-060000/pytorch_model.bin",
        ),
    ),
    "v460": CorpusVersion(
        copies=(
            mirror("corpus-python/src/"),
            corpus("v0.23.0-admin-surfaces", WRAPPED),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v4.6.0-admin-surfaces-base-60k.yaml",
            "corpus/versioned/v0.17.0-batch/corpus-v0.17.0-batch/train/part-sub-venue.parquet",
            "corpus/versioned/v0.22.0-psc-frsurfaces-v3/corpus-v0.22.0-psc-frsurfaces-v3/train/part-cz-pcfirst-v21.parquet",
            "corpus/versioned/v0.22.0-psc-frsurfaces-v3/corpus-v0.22.0-psc-frsurfaces-v3/train/part-fr-bare-street-v22.parquet",
            "corpus/versioned/v0.23.0-admin-surfaces/corpus-v0.23.0-admin-surfaces/MANIFEST.json",
            "corpus/versioned/v0.23.0-admin-surfaces/corpus-v0.23.0-admin-surfaces/train/part-bare-country-v23.parquet",
            "corpus/versioned/v0.23.0-admin-surfaces/corpus-v0.23.0-admin-surfaces/train/part-trailing-region-es-v23.parquet",
            "corpus/versioned/v0.23.0-admin-surfaces/corpus-v0.23.0-admin-surfaces/train/part-trailing-region-gb-v23.parquet",
            "models/tokenizer/v0.9.0-multisplice/tokenizer.model",
        ),
    ),
    "v530_reviewed_postcode_tail": CorpusVersion(
        copies=(
            mirror("corpus-python/src/", flags=STEADY),
            corpus("v0.28.0-reviewed-postcode-tail", WRAPPED, flags=STEADY),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v5.3.0-reviewed-ve-postcode-tail-60k.yaml",
            "corpus/versioned/v0.27.0-house-venue-intl/corpus-v0.27.0-house-venue-intl/MANIFEST.json",
            "corpus/versioned/v0.28.0-reviewed-postcode-tail/corpus-v0.28.0-reviewed-postcode-tail/MANIFEST.json",
            "corpus/versioned/v0.28.0-reviewed-postcode-tail/corpus-v0.28.0-reviewed-postcode-tail/train/reviewed-postcode-tail-00000.parquet",
            "models/tokenizer/v0.9.0-multisplice/tokenizer.model",
        ),
    ),
    "v540_target_families": CorpusVersion(
        copies=(
            mirror("corpus-python/src/", flags=STEADY),
            corpus("v0.29.0-target-families", WRAPPED, flags=STEADY),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v5.4.0-target-families-2k.yaml",
            "corpus-python/src/mailwoman_train/configs/v5.4.0-target-families-60k.yaml",
            "corpus-python/src/mailwoman_train/data/dose.py",
            "corpus/versioned/v0.28.0-reviewed-postcode-tail/corpus-v0.28.0-reviewed-postcode-tail/train/reviewed-postcode-tail-00000.parquet",
            "corpus/versioned/v0.29.0-target-families/corpus-v0.29.0-target-families/MANIFEST.json",
            "corpus/versioned/v0.29.0-target-families/corpus-v0.29.0-target-families/train/synth-sg-register-00000.parquet",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0000.parquet",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/val/part-0000.parquet",
            "models/tokenizer/v0.9.0-multisplice/tokenizer.model",
        ),
    ),
    "v560_bare_postcode": CorpusVersion(
        copies=(
            mirror("corpus-python/src/", flags=STEADY),
            corpus("v0.30.0-bare-postcode", WRAPPED, flags=STEADY),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v5.5.0-restored-generations-60k.yaml",
            "corpus-python/src/mailwoman_train/configs/v5.6.0-bare-postcode-60k.yaml",
            "corpus-python/src/mailwoman_train/data/dose.py",
            "corpus/versioned/v0.29.0-target-families/corpus-v0.29.0-target-families/train/synth-sg-register-00000.parquet",
            "corpus/versioned/v0.30.0-bare-postcode/corpus-v0.30.0-bare-postcode/MANIFEST.json",
            "corpus/versioned/v0.30.0-bare-postcode/corpus-v0.30.0-bare-postcode/train/synth-bare-postcode-00000.parquet",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0000.parquet",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/val/part-0000.parquet",
            "models/tokenizer/v0.9.0-multisplice/tokenizer.model",
        ),
    ),
    "v8cjk": CorpusVersion(
        copies=(
            mirror("corpus-python/src/", flags=STEADY),
            mirror("corpus-python/scripts/", flags=STEADY),
            corpus("v8-cjk-2026-09-05", FLAT, flags=STEADY),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v8-cjk-full-2k.yaml",
            "corpus-python/src/mailwoman_train/configs/v8-cjk-full.yaml",
            "corpus-python/src/mailwoman_train/evaluation/jp_probe_board.py",
            "corpus-python/src/mailwoman_train/labels.py",
            "corpus/versioned/v8-cjk-2026-09-05/MANIFEST.json",
            "corpus/versioned/v8-cjk-2026-09-05/char-vocab-cjk.json",
            "corpus/versioned/v8-cjk-2026-09-05/train/cn-units-0000.parquet",
            "corpus/versioned/v8-cjk-2026-09-05/val/cn-units-0000.parquet",
            "corpus/versioned/v8-jp-full-2026-08-04/jp-board.jsonl",
            "corpus/versioned/v8-jp-full-2026-08-04/train/part-0000.parquet",
            "corpus/versioned/v8-jp-full-2026-08-04/train/part-0001.parquet",
            "corpus/versioned/v8-jp-full-2026-08-04/train/part-0002.parquet",
            "corpus/versioned/v8-jp-full-2026-08-04/train/part-0003.parquet",
            "corpus/versioned/v8-jp-full-2026-08-04/train/part-0004.parquet",
            "corpus/versioned/v8-jp-full-2026-08-04/train/part-0005.parquet",
            "corpus/versioned/v8-jp-full-2026-08-04/train/part-0006.parquet",
            "corpus/versioned/v8-jp-full-2026-08-04/train/part-0007.parquet",
            "corpus/versioned/v8-jp-full-2026-08-04/val/part-0000.parquet",
        ),
        verifier=("mailwoman_train.countries.cjk.staging", "staged_overlay"),
    ),
    "v8cjk_kana": CorpusVersion(
        copies=(
            mirror("corpus-python/src/", flags=STEADY),
            mirror("corpus-python/scripts/", flags=STEADY),
            corpus("v8-jp-kana-2026-09-06", FLAT, flags=STEADY),
            corpus("v8-cjk-kana-2026-09-06", FLAT, flags=STEADY),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v8-cjk-kana.yaml",
            "corpus-python/src/mailwoman_train/countries/jp/corpora/__init__.py",
            "corpus/versioned/v8-cjk-kana-2026-09-06/MANIFEST.json",
            "corpus/versioned/v8-cjk-kana-2026-09-06/char-vocab-cjk.json",
            "corpus/versioned/v8-cjk-kana-2026-09-06/train/cn-units-0000.parquet",
            "corpus/versioned/v8-cjk-kana-2026-09-06/val/cn-units-0000.parquet",
            "corpus/versioned/v8-jp-kana-2026-09-06/jp-board.jsonl",
            "corpus/versioned/v8-jp-kana-2026-09-06/train/part-0000.parquet",
            "corpus/versioned/v8-jp-kana-2026-09-06/train/part-0001.parquet",
            "corpus/versioned/v8-jp-kana-2026-09-06/train/part-0002.parquet",
            "corpus/versioned/v8-jp-kana-2026-09-06/train/part-0003.parquet",
            "corpus/versioned/v8-jp-kana-2026-09-06/train/part-0004.parquet",
            "corpus/versioned/v8-jp-kana-2026-09-06/train/part-0005.parquet",
            "corpus/versioned/v8-jp-kana-2026-09-06/train/part-0006.parquet",
            "corpus/versioned/v8-jp-kana-2026-09-06/train/part-0007.parquet",
            "corpus/versioned/v8-jp-kana-2026-09-06/val/part-0000.parquet",
        ),
    ),
    "v8cjk_kr": CorpusVersion(
        copies=(
            mirror("corpus-python/src/", flags=STEADY),
            mirror("corpus-python/scripts/", flags=STEADY),
            corpus("v8-jp-kana-2026-09-06", FLAT, flags=STEADY),
            corpus("v8-kr-2026-09-06", FLAT, flags=STEADY),
            corpus("v8-cjk-kr-2026-09-06", FLAT, flags=STEADY),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v8-cjk-kr-probe.yaml",
            "corpus-python/src/mailwoman_train/configs/v8-cjk-kr.yaml",
            "corpus-python/src/mailwoman_train/countries/kr/corpora/__init__.py",
            "corpus/versioned/v8-cjk-kr-2026-09-06/MANIFEST.json",
            "corpus/versioned/v8-cjk-kr-2026-09-06/char-vocab-cjk.json",
            "corpus/versioned/v8-cjk-kr-2026-09-06/train/cn-units-0000.parquet",
            "corpus/versioned/v8-kr-2026-09-06/kr-board.jsonl",
            "corpus/versioned/v8-kr-2026-09-06/kr-sigungu-centroids.json",
            "corpus/versioned/v8-kr-2026-09-06/train/kr-part-0000.parquet",
            "corpus/versioned/v8-kr-2026-09-06/train/kr-part-0001.parquet",
            "corpus/versioned/v8-kr-2026-09-06/train/kr-part-0002.parquet",
            "corpus/versioned/v8-kr-2026-09-06/train/kr-part-0003.parquet",
            "corpus/versioned/v8-kr-2026-09-06/train/kr-part-0004.parquet",
            "corpus/versioned/v8-kr-2026-09-06/train/kr-part-0005.parquet",
            "corpus/versioned/v8-kr-2026-09-06/train/kr-part-0006.parquet",
            "corpus/versioned/v8-kr-2026-09-06/train/kr-part-0007.parquet",
            "corpus/versioned/v8-kr-2026-09-06/val/kr-part-0000.parquet",
        ),
    ),
    "v8cjk_regs": CorpusVersion(
        copies=(
            mirror("corpus-python/src/", flags=STEADY),
            mirror("corpus-python/scripts/", flags=STEADY),
            corpus("v8-jp-kana-2026-09-06", FLAT, flags=STEADY),
            corpus("v8-kr-2026-09-08", FLAT, flags=STEADY),
            corpus("v8-kr-registry-2026-09-08", FLAT, flags=STEADY),
            corpus("v8-tw-2026-09-08", FLAT, flags=STEADY),
            corpus("v8-tw-registry-2026-09-08", FLAT, flags=STEADY),
            corpus("v8-jp-registry-2026-09-08", FLAT, flags=STEADY),
            corpus("v8-cjk-regs-2026-09-08", FLAT, flags=STEADY),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        verifier=("mailwoman_train.countries.cjk.staging", "staged_registries"),
    ),
    "v8cjk_shi": CorpusVersion(
        copies=(
            mirror("corpus-python/src/", flags=STEADY),
            mirror("corpus-python/scripts/", flags=STEADY),
            corpus("v8-jp-shi-2026-09-06", FLAT, flags=STEADY),
            corpus("v8-cjk-shi-2026-09-06", FLAT, flags=STEADY),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v8-cjk-shi.yaml",
            "corpus-python/src/mailwoman_train/countries/jp/corpora/__init__.py",
            "corpus/versioned/v8-cjk-shi-2026-09-06/MANIFEST.json",
            "corpus/versioned/v8-cjk-shi-2026-09-06/char-vocab-cjk.json",
            "corpus/versioned/v8-jp-shi-2026-09-06/jp-board.jsonl",
            "corpus/versioned/v8-jp-shi-2026-09-06/train/part-0000.parquet",
            "corpus/versioned/v8-jp-shi-2026-09-06/train/part-0001.parquet",
            "corpus/versioned/v8-jp-shi-2026-09-06/train/part-0002.parquet",
            "corpus/versioned/v8-jp-shi-2026-09-06/train/part-0003.parquet",
            "corpus/versioned/v8-jp-shi-2026-09-06/train/part-0004.parquet",
            "corpus/versioned/v8-jp-shi-2026-09-06/train/part-0005.parquet",
            "corpus/versioned/v8-jp-shi-2026-09-06/train/part-0006.parquet",
            "corpus/versioned/v8-jp-shi-2026-09-06/train/part-0007.parquet",
            "corpus/versioned/v8-jp-shi-2026-09-06/val/part-0000.parquet",
        ),
    ),
}
