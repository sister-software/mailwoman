"""Build the Korea slices.

Usage:
    python -m mailwoman_train.countries.kr.corpora \\
        --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-kr-<date> \\
        --registry-out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-kr-registry-<date>
"""

from __future__ import annotations

import sys

from .assemble import main

if __name__ == "__main__":
    main(sys.argv[1:])
