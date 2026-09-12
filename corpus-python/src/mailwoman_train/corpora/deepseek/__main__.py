"""Generate an adversarial corpus.

Usage:
    python -m mailwoman_train.corpora.deepseek --mode kryptonite --out-dir out/ --target-count 8000
    python -m mailwoman_train.corpora.deepseek --mode transliteration --out-dir out/ \\
        --seed-paths seeds-us.jsonl seeds-fr.jsonl
"""

from __future__ import annotations

from .cli import main

if __name__ == "__main__":
    main()
