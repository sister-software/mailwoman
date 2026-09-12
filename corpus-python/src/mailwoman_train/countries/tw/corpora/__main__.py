"""Build the Taiwan slice.

Usage::

    python -m mailwoman_train.countries.tw.corpora \\
        --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-tw-2026-09-08 \\
        --train-rows 2000000 --val-rows 20000 --board-rows 20000

    # smoke slice (first N row groups, small targets — the rung below a full build)
    python -m mailwoman_train.countries.tw.corpora --out-dir /tmp/tw-smoke \\
        --max-row-groups 4 --train-rows 20000 --val-rows 1000 --board-rows 1000
"""

from __future__ import annotations

from .assemble import main

if __name__ == "__main__":
    main()
