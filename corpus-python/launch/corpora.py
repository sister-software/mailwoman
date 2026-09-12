"""What each corpus version stages onto the volume, as data.

One entry per version. A new version is a row here, not a new Modal function — the variation
between versions is which directories move and which files must land afterwards, and that is a
manifest rather than code. `launch/plan.py` turns a row into commands; `launch/sync.py` runs them.

Each row carries both halves of every transfer. The destination is not derived from the source
because 100 of the 137 transfers disagree with any single rule that could derive it: a corpus
version usually lands under `corpus/versioned/<version>/corpus-<version>/`, sometimes under
`corpus/versioned/<version>/` with no inner directory, and a single lexicon file lands in a
directory rather than at a path. Carrying both is what a manifest is for.

`checks` are the paths the sync verifies after copying. They matter because rclone EXITS 0 WHEN THE
SOURCE PREFIX IS EMPTY: without a check, a version whose R2 prefix was never uploaded syncs
"successfully" and the training job fails much later on a missing parquet part, with nothing
pointing back at the sync.
"""

from __future__ import annotations

from .plan import (
    NARROW,
    NONE,
    PACKAGE_AND_CONFIGS,
    PLAIN,
    STEADY,
    STEADY_LOGGED,
    WIDE,
    WIDEST,
    Copy,
    CorpusVersion,
)

#: Keyed by the name that followed `sync_` on the function this replaces, so an operator who knows
#: `sync_v8cjk_kr` finds `v8cjk_kr`.
CORPUS_VERSIONS: dict[str, CorpusVersion] = {
    "assets": CorpusVersion(
        copies=(),
    ),
    "corpus": CorpusVersion(
        copies=(
            Copy("corpus/v0.3.0/", "corpus/versioned/v0.3.0/corpus-v0.3.0/", WIDEST),
            Copy("corpus/v0.4.0/", "corpus/versioned/v0.4.0/corpus-v0.4.0/", PLAIN),
            Copy("models/tokenizer/", "models/tokenizer/", NARROW),
            Copy("corpus-python/", "corpus-python/", NARROW),
        ),
        pycache=NONE,
    ),
    "country_channel": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy("gazetteer/", "gazetteer/", WIDE),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v2.6.3-country-channel.yaml",
            "corpus/versioned/v0.10.6-fragment-v5/corpus-v0.10.6-fragment-v5/MANIFEST.json",
            "gazetteer/country-surface-lexicon-v1.json",
            "output-v261-span-boundary-full-s42/checkpoints/step-008000",
        ),
    ),
    "country_softguard": CorpusVersion(
        copies=(Copy("corpus-python/src/", "corpus-python/src/", WIDE),),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v2.6.4-country-softguard.yaml",
            "corpus/versioned/v0.10.6-fragment-v5/corpus-v0.10.6-fragment-v5/MANIFEST.json",
            "gazetteer/country-surface-lexicon-v1.json",
            "output-v263-country-channel-s42/checkpoints/step-008000",
        ),
    ),
    "deploc": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.15.0-deploc/corpus-v0.15.0-deploc/",
                "corpus/versioned/v0.15.0-deploc/corpus-v0.15.0-deploc/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v3.11.0-deploc-feed.yaml",
            "corpus/versioned/v0.14.0-gb/corpus-v0.14.0-gb/train/part-gb.parquet",
            "corpus/versioned/v0.15.0-deploc/corpus-v0.15.0-deploc/MANIFEST.json",
            "corpus/versioned/v0.15.0-deploc/corpus-v0.15.0-deploc/train/part-es-pedania.parquet",
            "corpus/versioned/v0.15.0-deploc/corpus-v0.15.0-deploc/train/part-fr-lieudit.parquet",
            "corpus/versioned/v0.15.0-deploc/corpus-v0.15.0-deploc/train/part-nz.parquet",
            "models/tokenizer/v0.9.0-multisplice/tokenizer.model",
            "output-v384-latam-probe-s42/checkpoints/step-008000",
        ),
    ),
    "deploc_head": CorpusVersion(
        copies=(Copy("corpus-python/src/", "corpus-python/src/", WIDE),),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v3.14.0-deploc-head.yaml",
            "output-v384-latam-probe-s42/checkpoints/step-008000",
        ),
    ),
    "evidence_bundle": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy("gazetteer/locality-surface-lexicon-v1.json", "gazetteer/", WIDE),
            Copy("gazetteer/locality-surface-lexicon-v2.json", "gazetteer/", WIDE),
            Copy("gazetteer/locality-surface-lexicon-v3.json", "gazetteer/", WIDE),
            Copy("gazetteer/locality-surface-lexicon-v4.json", "gazetteer/", WIDE),
            Copy("gazetteer/locality-surface-lexicon-v5.json", "gazetteer/", WIDE),
            Copy("gazetteer/street-type-lexicon-v2.json", "gazetteer/", WIDE),
            Copy("gazetteer/locality-surface-lexicon-v6.json", "gazetteer/", WIDE),
            Copy("gazetteer/street-type-lexicon-v3.json", "gazetteer/", WIDE),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v3.16.0-evidence-bundle.yaml",
            "gazetteer/locality-surface-lexicon-v1.json",
            "gazetteer/street-type-lexicon-v1.json",
            "output-v384-latam-probe-s42/checkpoints/step-008000",
        ),
    ),
    "gb": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy("corpus/v0.14.0-gb/corpus-v0.14.0-gb/", "corpus/versioned/v0.14.0-gb/corpus-v0.14.0-gb/", WIDE),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v3.10.0-gb-probe.yaml",
            "corpus/versioned/v0.11.0-no-fragment/corpus-v0.11.0-no-fragment/MANIFEST.json",
            "corpus/versioned/v0.13.0-latam/corpus-v0.13.0-latam/train/part-latam.parquet",
            "corpus/versioned/v0.14.0-gb/corpus-v0.14.0-gb/MANIFEST.json",
            "corpus/versioned/v0.14.0-gb/corpus-v0.14.0-gb/train/part-gb.parquet",
            "models/tokenizer/v0.9.0-multisplice/tokenizer.model",
            "output-v384-latam-probe-s42/checkpoints/step-008000",
        ),
    ),
    "gb_venue": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy("corpus/v0.15.1-gb-venue/", "corpus/versioned/v0.15.1-gb-venue/", WIDE),
            Copy("corpus/v0.15.2-gb-venue-country/", "corpus/versioned/v0.15.2-gb-venue-country/", WIDE),
        ),
    ),
    "jp_full": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy("corpus/v8-jp-full-2026-08-04/", "corpus/versioned/v8-jp-full-2026-08-04/", WIDE),
            Copy("corpus/v8-jp-probe/jp-muni-centroids.json", "corpus/versioned/v8-jp-probe/", WIDE),
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
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy("corpus/v8-jp-probe/", "corpus/versioned/v8-jp-probe/", WIDE),
            Copy("corpus/v8-leg2/", "corpus/versioned/v8-leg2/", WIDE),
            Copy("gazetteer/locality-surface-lexicon-v7.json", "gazetteer/", WIDE),
            Copy("corpus/v0.15.0-venue/", "corpus/versioned/v0.15.0-venue/", WIDE),
            Copy("eval/fixtures/overture-fragments-de.jsonl", "eval/fixtures/", WIDE),
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
    "latam": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.13.0-latam/corpus-v0.13.0-latam/",
                "corpus/versioned/v0.13.0-latam/corpus-v0.13.0-latam/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v3.8.4-latam-probe.yaml",
            "corpus/versioned/v0.11.0-no-fragment/corpus-v0.11.0-no-fragment/MANIFEST.json",
            "corpus/versioned/v0.13.0-latam/corpus-v0.13.0-latam/MANIFEST.json",
            "corpus/versioned/v0.13.0-latam/corpus-v0.13.0-latam/train/part-latam.parquet",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0000.parquet",
            "models/tokenizer/v0.9.0-multisplice/tokenizer.model",
            "output-v381-punct-fix-full-s42/checkpoints/step-008000",
        ),
    ),
    "latam_br": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.14.0-latam-br/corpus-v0.14.0-latam-br/",
                "corpus/versioned/v0.14.0-latam-br/corpus-v0.14.0-latam-br/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v3.8.6-latam-br-8k.yaml",
            "corpus/versioned/v0.11.0-no-fragment/corpus-v0.11.0-no-fragment/MANIFEST.json",
            "corpus/versioned/v0.13.0-latam/corpus-v0.13.0-latam/train/part-latam.parquet",
            "corpus/versioned/v0.14.0-latam-br/corpus-v0.14.0-latam-br/MANIFEST.json",
            "corpus/versioned/v0.14.0-latam-br/corpus-v0.14.0-latam-br/train/part-br.parquet",
            "models/tokenizer/v0.9.0-multisplice/tokenizer.model",
            "output-v381-punct-fix-full-s42/checkpoints/step-008000",
        ),
    ),
    "no_fragment_b4b": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.11.0-no-fragment/corpus-v0.11.0-no-fragment/",
                "corpus/versioned/v0.11.0-no-fragment/corpus-v0.11.0-no-fragment/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v3.6.0-no-fragment-b4b.yaml",
            "corpus/versioned/v0.10.9-fr-fragment/corpus-v0.10.9-fr-fragment/MANIFEST.json",
            "corpus/versioned/v0.11.0-no-fragment/corpus-v0.11.0-no-fragment/MANIFEST.json",
            "corpus/versioned/v0.11.0-no-fragment/corpus-v0.11.0-no-fragment/train/part-no-fragment.parquet",
            "models/tokenizer/v0.9.0-multisplice/tokenizer.model",
        ),
    ),
    "nsplice": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", STEADY),
            Copy("models/tokenizer/v0.7.0-nsplice/", "models/tokenizer/v0.7.0-nsplice/", STEADY),
            Copy("models/tokenizer/v0.7.1-nsplice/", "models/tokenizer/v0.7.1-nsplice/", STEADY),
        ),
        checks=(
            "models/bsplice-expanded/pytorch_model.bin",
            "models/tokenizer/v0.7.0-nsplice/tokenizer.model",
        ),
    ),
    "nz": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy("corpus/v0.12.0-nz/corpus-v0.12.0-nz/", "corpus/versioned/v0.12.0-nz/corpus-v0.12.0-nz/", WIDE),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v3.8.2-nz-locale-probe.yaml",
            "corpus/versioned/v0.11.0-no-fragment/corpus-v0.11.0-no-fragment/MANIFEST.json",
            "corpus/versioned/v0.12.0-nz/corpus-v0.12.0-nz/MANIFEST.json",
            "corpus/versioned/v0.12.0-nz/corpus-v0.12.0-nz/train/part-nz.parquet",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0000.parquet",
            "models/tokenizer/v0.9.0-multisplice/tokenizer.model",
            "output-v381-punct-fix-full-s42/checkpoints/step-008000",
        ),
    ),
    "src_727": CorpusVersion(
        copies=(Copy("corpus-python/src/", "corpus-python/src/", WIDE),),
        checks=("corpus-python/src/mailwoman_train/configs/v2.6.0-span-boundary-probe.yaml",),
    ),
    "src_727_stage2": CorpusVersion(
        copies=(Copy("corpus-python/src/", "corpus-python/src/", WIDE),),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v3.0.0-span-head.yaml",
            "corpus-python/src/mailwoman_train/configs/v3.0.1-span-head-lr.yaml",
            "corpus-python/src/mailwoman_train/nn/span_scorer.py",
        ),
    ),
    "src_gb": CorpusVersion(
        copies=(Copy("corpus-python/src/", "corpus-python/src/", WIDE),),
    ),
    "src_v3100": CorpusVersion(
        copies=(Copy("corpus-python/src/", "corpus-python/src/", WIDE),),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v3.10.0-span-ship-probe.yaml",
            "corpus-python/src/mailwoman_train/nn/span_scorer.py",
        ),
    ),
    "street_type": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy("gazetteer/street-type-lexicon-v1.json", "gazetteer/", WIDE),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v3.15.0-street-type.yaml",
            "gazetteer/street-type-lexicon-v1.json",
            "output-v384-latam-probe-s42/checkpoints/step-008000",
        ),
    ),
    "substrate_repairs": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy("gazetteer/affix-relabel-lexicon-v2.json", "gazetteer/", WIDE),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/audits/epoch_mixture.py",
            "corpus-python/src/mailwoman_train/configs/v4.3.3-cooldown46k.yaml",
            "corpus-python/src/mailwoman_train/data/loader.py",
            "corpus-python/src/mailwoman_train/data/relabel.py",
            "corpus-python/src/mailwoman_train/optim/schedules.py",
            "corpus-python/src/mailwoman_train/train/checkpoint.py",
            "gazetteer/affix-relabel-lexicon-v2.json",
        ),
    ),
    "v050": CorpusVersion(
        copies=(
            Copy("corpus/v0.5.0/corpus-v0.5.0/", "corpus/versioned/v0.5.0/corpus-v0.5.0/", WIDE),
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.4.0-charoffset.yaml",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train",
        ),
    ),
    "v060": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.6.0-boundary-stress/corpus-v0.6.0-boundary-stress/",
                "corpus/versioned/v0.6.0-boundary-stress/corpus-v0.6.0-boundary-stress/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.6.0-boundary-stress.yaml",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet",
            "corpus/versioned/v0.6.0-boundary-stress/corpus-v0.6.0-boundary-stress/MANIFEST.json",
            "corpus/versioned/v0.6.0-boundary-stress/corpus-v0.6.0-boundary-stress/train/part-boundary-stress-train.parquet",
        ),
    ),
    "v061": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.6.1-boundary-stress/corpus-v0.6.1-boundary-stress/",
                "corpus/versioned/v0.6.1-boundary-stress/corpus-v0.6.1-boundary-stress/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.7.0-boundary-stress.yaml",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet",
            "corpus/versioned/v0.6.1-boundary-stress/corpus-v0.6.1-boundary-stress/MANIFEST.json",
            "corpus/versioned/v0.6.1-boundary-stress/corpus-v0.6.1-boundary-stress/train/part-boundary-stress-train.parquet",
        ),
    ),
    "v080": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.8.0-fr-admin-split/corpus-v0.8.0-fr-admin-split/",
                "corpus/versioned/v0.8.0-fr-admin-split/corpus-v0.8.0-fr-admin-split/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.8.0-fr-admin-split.yaml",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet",
            "corpus/versioned/v0.8.0-fr-admin-split/corpus-v0.8.0-fr-admin-split/MANIFEST.json",
            "corpus/versioned/v0.8.0-fr-admin-split/corpus-v0.8.0-fr-admin-split/train/part-fr-admin-split-train.parquet",
        ),
    ),
    "v081": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.8.1-fr-admin-split/corpus-v0.8.1-fr-admin-split/",
                "corpus/versioned/v0.8.1-fr-admin-split/corpus-v0.8.1-fr-admin-split/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.8.1-fr-admin-split.yaml",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet",
            "corpus/versioned/v0.8.1-fr-admin-split/corpus-v0.8.1-fr-admin-split/MANIFEST.json",
            "corpus/versioned/v0.8.1-fr-admin-split/corpus-v0.8.1-fr-admin-split/train/part-fr-admin-split-train.parquet",
        ),
    ),
    "v090": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.9.0-multilocale/corpus-v0.9.0-multilocale/",
                "corpus/versioned/v0.9.0-multilocale/corpus-v0.9.0-multilocale/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.9.0-multilocale.yaml",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet",
            "corpus/versioned/v0.8.0-fr-admin-split/corpus-v0.8.0-fr-admin-split/train/part-fr-admin-split-train.parquet",
            "corpus/versioned/v0.9.0-multilocale/corpus-v0.9.0-multilocale/MANIFEST.json",
            "corpus/versioned/v0.9.0-multilocale/corpus-v0.9.0-multilocale/train/part-overture-multilocale-train.parquet",
            "models/tokenizer/v0.6.0-a0/tokenizer.model",
        ),
    ),
    "v091": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.9.1-multilocale/corpus-v0.9.1-multilocale/",
                "corpus/versioned/v0.9.1-multilocale/corpus-v0.9.1-multilocale/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.9.1-multilocale-3order.yaml",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet",
            "corpus/versioned/v0.8.0-fr-admin-split/corpus-v0.8.0-fr-admin-split/train/part-fr-admin-split-train.parquet",
            "corpus/versioned/v0.9.1-multilocale/corpus-v0.9.1-multilocale/MANIFEST.json",
            "corpus/versioned/v0.9.1-multilocale/corpus-v0.9.1-multilocale/train/part-overture-multilocale-3order-train.parquet",
            "models/tokenizer/v0.6.0-a0/tokenizer.model",
        ),
    ),
    "v092": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.9.2-multilocale-au/corpus-v0.9.2-multilocale-au/",
                "corpus/versioned/v0.9.2-multilocale-au/corpus-v0.9.2-multilocale-au/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.9.2-multilocale-au.yaml",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet",
            "corpus/versioned/v0.9.1-multilocale/corpus-v0.9.1-multilocale/train/part-overture-multilocale-3order-train.parquet",
            "corpus/versioned/v0.9.2-multilocale-au/corpus-v0.9.2-multilocale-au/MANIFEST.json",
            "corpus/versioned/v0.9.2-multilocale-au/corpus-v0.9.2-multilocale-au/train/part-gnaf-au-train.parquet",
            "models/tokenizer/v0.6.0-a0/tokenizer.model",
        ),
    ),
    "v094_fr_bare": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.9.4-fr-bare-street/corpus-v0.9.4-fr-bare-street/",
                "corpus/versioned/v0.9.4-fr-bare-street/corpus-v0.9.4-fr-bare-street/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.9.4-fr-bare-street.yaml",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet",
            "corpus/versioned/v0.9.4-fr-bare-street/corpus-v0.9.4-fr-bare-street/MANIFEST.json",
            "corpus/versioned/v0.9.4-fr-bare-street/corpus-v0.9.4-fr-bare-street/train/part-fr-bare-street-train.parquet",
            "output-v194-fr-bare-street-s42/checkpoints/step-080000",
        ),
    ),
    "v095_case": CorpusVersion(
        copies=(Copy("corpus-python/src/", "corpus-python/src/", WIDE),),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.9.5-surface-aug.yaml",
            "corpus-python/src/mailwoman_train/data/augment.py",
            "output-v195-surface-aug-s42/checkpoints/step-092000",
        ),
    ),
    "v193": CorpusVersion(
        copies=(Copy("corpus-python/src/", "corpus-python/src/", WIDE),),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.9.3-anchor-absorption.yaml",
            "corpus-python/src/mailwoman_train/features/postcode_shapes.py",
            "corpus/versioned/v0.9.2-multilocale-au/corpus-v0.9.2-multilocale-au/MANIFEST.json",
            "models/tokenizer/v0.6.0-a0/tokenizer.model",
            "output-v193-anchor-absorption-s42/checkpoints/step-040000",
        ),
    ),
    "v193a1": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.9.3-anchor-absorption/corpus-v0.9.3-anchor-absorption/",
                "corpus/versioned/v0.9.3-anchor-absorption/corpus-v0.9.3-anchor-absorption/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.9.3a1-anchor-absorption.yaml",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet",
            "corpus/versioned/v0.9.2-multilocale-au/corpus-v0.9.2-multilocale-au/train/part-gnaf-au-train.parquet",
            "corpus/versioned/v0.9.3-anchor-absorption/corpus-v0.9.3-anchor-absorption/MANIFEST.json",
            "corpus/versioned/v0.9.3-anchor-absorption/corpus-v0.9.3-anchor-absorption/train/part-anchor-absorption-train.parquet",
            "output-v193a1-anchor-absorption-s42/checkpoints/step-040000",
        ),
    ),
    "v193a2": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.9.3a2-anchor-absorption/corpus-v0.9.3a2-anchor-absorption/",
                "corpus/versioned/v0.9.3a2-anchor-absorption/corpus-v0.9.3a2-anchor-absorption/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.9.3a2-anchor-absorption.yaml",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet",
            "corpus/versioned/v0.9.2-multilocale-au/corpus-v0.9.2-multilocale-au/train/part-gnaf-au-train.parquet",
            "corpus/versioned/v0.9.3a2-anchor-absorption/corpus-v0.9.3a2-anchor-absorption/MANIFEST.json",
            "corpus/versioned/v0.9.3a2-anchor-absorption/corpus-v0.9.3a2-anchor-absorption/train/part-anchor-absorption-train.parquet",
            "output-v193a2-anchor-absorption-s42/checkpoints/step-040000",
        ),
    ),
    "v193a3": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.9.3a3-anchor-absorption/corpus-v0.9.3a3-anchor-absorption/",
                "corpus/versioned/v0.9.3a3-anchor-absorption/corpus-v0.9.3a3-anchor-absorption/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.9.3a3-anchor-absorption.yaml",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet",
            "corpus/versioned/v0.9.2-multilocale-au/corpus-v0.9.2-multilocale-au/train/part-gnaf-au-train.parquet",
            "corpus/versioned/v0.9.3a3-anchor-absorption/corpus-v0.9.3a3-anchor-absorption/MANIFEST.json",
            "corpus/versioned/v0.9.3a3-anchor-absorption/corpus-v0.9.3a3-anchor-absorption/train/part-anchor-absorption-train.parquet",
            "output-v193a3-anchor-absorption-s42/checkpoints/step-040000",
        ),
    ),
    "v196_slavic": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.9.6-slavic-anchor/corpus-v0.9.6-slavic-anchor/",
                "corpus/versioned/v0.9.6-slavic-anchor/corpus-v0.9.6-slavic-anchor/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.9.6-slavic-anchor.yaml",
            "corpus/versioned/v0.9.3a3-anchor-absorption/corpus-v0.9.3a3-anchor-absorption/MANIFEST.json",
            "corpus/versioned/v0.9.3a3-anchor-absorption/corpus-v0.9.3a3-anchor-absorption/train/part-anchor-absorption-train.parquet",
            "corpus/versioned/v0.9.6-slavic-anchor/corpus-v0.9.6-slavic-anchor/MANIFEST.json",
            "corpus/versioned/v0.9.6-slavic-anchor/corpus-v0.9.6-slavic-anchor/train/part-oa-slavic-diacritic-train.parquet",
            "models/tokenizer/v0.6.0-a0/tokenizer.model",
        ),
    ),
    "v197_bsplice": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", STEADY_LOGGED),
            Copy("models/tokenizer/v0.6.0-bsplice/", "models/tokenizer/v0.6.0-bsplice/", STEADY_LOGGED),
            Copy("models/bsplice-expanded/", "models/bsplice-expanded/", STEADY_LOGGED),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v1.9.7-bsplice.yaml",
            "corpus/versioned/v0.9.6-slavic-anchor/corpus-v0.9.6-slavic-anchor/MANIFEST.json",
            "models/bsplice-expanded/config.json",
            "models/bsplice-expanded/pytorch_model.bin",
            "models/tokenizer/v0.6.0-bsplice/tokenizer.model",
        ),
    ),
    "v210": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", STEADY),
            Copy(
                "corpus/v0.10.0-boundary-family/corpus-v0.10.0-boundary-family/",
                "corpus/versioned/v0.10.0-boundary-family/corpus-v0.10.0-boundary-family/",
                STEADY,
            ),
        ),
    ),
    "v241_fr_nsplice": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", STEADY),
            Copy("models/tokenizer/v0.8.0-fr-nsplice/", "models/tokenizer/v0.8.0-fr-nsplice/", STEADY),
        ),
    ),
    "v420_batch": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy("corpus/v0.17.0-batch/", "corpus/versioned/v0.17.0-batch/corpus-v0.17.0-batch/", WIDE),
            Copy("anchor/pilot-anchor-lookup-v2-2026-08-05.json", "anchor/", WIDE),
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
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.18.1-suffix-boundary/",
                "corpus/versioned/v0.18.1-suffix-boundary/corpus-v0.18.1-suffix-boundary/",
                WIDE,
            ),
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
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.19.0-suffix-boundary-v2/",
                "corpus/versioned/v0.19.0-suffix-boundary-v2/corpus-v0.19.0-suffix-boundary-v2/",
                WIDE,
            ),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v4.4.0-suffix-boundary-v2-base-60k.yaml",
            "corpus-python/src/mailwoman_train/data/loader.py",
            "corpus/versioned/v0.17.0-batch/corpus-v0.17.0-batch/train/part-sub-venue.parquet",
            "corpus/versioned/v0.19.0-suffix-boundary-v2/corpus-v0.19.0-suffix-boundary-v2/MANIFEST.json",
            "corpus/versioned/v0.19.0-suffix-boundary-v2/corpus-v0.19.0-suffix-boundary-v2/train/part-suffix-boundary-v2.parquet",
            "gazetteer/affix-relabel-lexicon-v2.json",
            "models/tokenizer/v0.9.0-multisplice/tokenizer.model",
        ),
    ),
    "v450": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.20.0-psc-frsurfaces/",
                "corpus/versioned/v0.20.0-psc-frsurfaces/corpus-v0.20.0-psc-frsurfaces/",
                WIDE,
            ),
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
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.21.0-psc-frsurfaces-v2/",
                "corpus/versioned/v0.21.0-psc-frsurfaces-v2/corpus-v0.21.0-psc-frsurfaces-v2/",
                WIDE,
            ),
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
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.22.0-psc-frsurfaces-v3/",
                "corpus/versioned/v0.22.0-psc-frsurfaces-v3/corpus-v0.22.0-psc-frsurfaces-v3/",
                WIDE,
            ),
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
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.23.0-admin-surfaces/",
                "corpus/versioned/v0.23.0-admin-surfaces/corpus-v0.23.0-admin-surfaces/",
                WIDE,
            ),
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
            Copy("corpus-python/src/", "corpus-python/src/", STEADY),
            Copy(
                "corpus/v0.28.0-reviewed-postcode-tail/",
                "corpus/versioned/v0.28.0-reviewed-postcode-tail/corpus-v0.28.0-reviewed-postcode-tail/",
                STEADY,
            ),
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
            Copy("corpus-python/src/", "corpus-python/src/", STEADY),
            Copy(
                "corpus/v0.29.0-target-families/",
                "corpus/versioned/v0.29.0-target-families/corpus-v0.29.0-target-families/",
                STEADY,
            ),
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
            Copy("corpus-python/src/", "corpus-python/src/", STEADY),
            Copy(
                "corpus/v0.30.0-bare-postcode/",
                "corpus/versioned/v0.30.0-bare-postcode/corpus-v0.30.0-bare-postcode/",
                STEADY,
            ),
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
    "v6": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.10.7-fragment-v6/corpus-v0.10.7-fragment-v6/",
                "corpus/versioned/v0.10.7-fragment-v6/corpus-v0.10.7-fragment-v6/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v2.9.0-country-counterweight.yaml",
            "corpus/versioned/v0.10.7-fragment-v6/corpus-v0.10.7-fragment-v6/MANIFEST.json",
            "corpus/versioned/v0.10.7-fragment-v6/corpus-v0.10.7-fragment-v6/train/part-fragment.parquet",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/test/part-0000.parquet",
        ),
    ),
    "v7": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", WIDE),
            Copy(
                "corpus/v0.10.8-fragment-v7/corpus-v0.10.8-fragment-v7/",
                "corpus/versioned/v0.10.8-fragment-v7/corpus-v0.10.8-fragment-v7/",
                WIDE,
            ),
        ),
        checks=(
            "corpus-python/src/mailwoman_train/configs/v2.9.1-country-leading.yaml",
            "corpus/versioned/v0.10.8-fragment-v7/corpus-v0.10.8-fragment-v7/MANIFEST.json",
            "corpus/versioned/v0.10.8-fragment-v7/corpus-v0.10.8-fragment-v7/train/part-fragment.parquet",
            "corpus/versioned/v0.5.0/corpus-v0.5.0/test/part-0000.parquet",
        ),
    ),
    "v8cjk": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", STEADY),
            Copy("corpus-python/scripts/", "corpus-python/scripts/", STEADY),
            Copy("corpus/v8-cjk-2026-09-05/", "corpus/versioned/v8-cjk-2026-09-05/", STEADY),
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
    ),
    "v8cjk_kana": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", STEADY),
            Copy("corpus-python/scripts/", "corpus-python/scripts/", STEADY),
            Copy("corpus/v8-jp-kana-2026-09-06/", "corpus/versioned/v8-jp-kana-2026-09-06/", STEADY),
            Copy("corpus/v8-cjk-kana-2026-09-06/", "corpus/versioned/v8-cjk-kana-2026-09-06/", STEADY),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v8-cjk-kana.yaml",
            "corpus-python/src/mailwoman_train/countries/jp/corpora.py",
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
            Copy("corpus-python/src/", "corpus-python/src/", STEADY),
            Copy("corpus-python/scripts/", "corpus-python/scripts/", STEADY),
            Copy("corpus/v8-jp-kana-2026-09-06/", "corpus/versioned/v8-jp-kana-2026-09-06/", STEADY),
            Copy("corpus/v8-kr-2026-09-06/", "corpus/versioned/v8-kr-2026-09-06/", STEADY),
            Copy("corpus/v8-cjk-kr-2026-09-06/", "corpus/versioned/v8-cjk-kr-2026-09-06/", STEADY),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v8-cjk-kr-probe.yaml",
            "corpus-python/src/mailwoman_train/configs/v8-cjk-kr.yaml",
            "corpus-python/src/mailwoman_train/countries/kr/corpora.py",
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
            Copy("corpus-python/src/", "corpus-python/src/", STEADY),
            Copy("corpus-python/scripts/", "corpus-python/scripts/", STEADY),
            Copy("corpus/v8-jp-kana-2026-09-06/", "corpus/versioned/v8-jp-kana-2026-09-06/", STEADY),
            Copy("corpus/v8-kr-2026-09-08/", "corpus/versioned/v8-kr-2026-09-08/", STEADY),
            Copy("corpus/v8-kr-registry-2026-09-08/", "corpus/versioned/v8-kr-registry-2026-09-08/", STEADY),
            Copy("corpus/v8-tw-2026-09-08/", "corpus/versioned/v8-tw-2026-09-08/", STEADY),
            Copy("corpus/v8-tw-registry-2026-09-08/", "corpus/versioned/v8-tw-registry-2026-09-08/", STEADY),
            Copy("corpus/v8-jp-registry-2026-09-08/", "corpus/versioned/v8-jp-registry-2026-09-08/", STEADY),
            Copy("corpus/v8-cjk-regs-2026-09-08/", "corpus/versioned/v8-cjk-regs-2026-09-08/", STEADY),
        ),
        pycache=PACKAGE_AND_CONFIGS,
    ),
    "v8cjk_shi": CorpusVersion(
        copies=(
            Copy("corpus-python/src/", "corpus-python/src/", STEADY),
            Copy("corpus-python/scripts/", "corpus-python/scripts/", STEADY),
            Copy("corpus/v8-jp-shi-2026-09-06/", "corpus/versioned/v8-jp-shi-2026-09-06/", STEADY),
            Copy("corpus/v8-cjk-shi-2026-09-06/", "corpus/versioned/v8-cjk-shi-2026-09-06/", STEADY),
        ),
        pycache=PACKAGE_AND_CONFIGS,
        checks=(
            "corpus-python/src/mailwoman_train/configs/v8-cjk-shi.yaml",
            "corpus-python/src/mailwoman_train/countries/jp/corpora.py",
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
