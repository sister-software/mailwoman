"""Build the Japan slice.

Usage::

    python -m mailwoman_train.countries.jp.corpora \\
        --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-full-2026-08-04 \\
        --train-rows 2000000 --val-rows 20000 --board-rows 20000

    # smoke slice (first N row groups, small targets — the rung below a full build)
    python -m mailwoman_train.countries.jp.corpora --out-dir /tmp/jp-smoke \\
        --max-row-groups 4 --train-rows 20000 --val-rows 1000 --board-rows 1000
"""

from __future__ import annotations

from .assemble import main

if __name__ == "__main__":
    main()
