"""Build the fragment slice.

Usage:
    python -m mailwoman_train.corpora.fragment \
        --oa-root "$MAILWOMAN_DATA_ROOT/openaddresses/extracted" \
        --corpus-parquet-glob "$MAILWOMAN_DATA_ROOT/corpus/versioned/v0.5.0/**/train/part-000*.parquet" \
        --out-parquet out/part-fragment.parquet --out-dev out/fragment-dev.jsonl
"""

from __future__ import annotations

from .build import main

if __name__ == "__main__":
    main()
