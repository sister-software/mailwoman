"""DeepSeek-driven adversarial corpus generation for corpus-v0.4.0 (Thread B of the v0.5.0
fresh-slate plan, PHASE_8 §B).

Two modes:

- ``--mode transliteration``: reads seed JSONL lines of US/FR canonical addresses with
  ``components`` ground truth and asks DeepSeek to render each address in a target
  non-Latin script (Russian Cyrillic, Japanese Kana+Kanji, Simplified Chinese, Korean
  Hangul, Armenian). Each output row carries the transliterated raw + transliterated
  component surface forms (substring-match invariant enforced by the model and
  re-validated locally before write).

- ``--mode kryptonite``: prompt-engineers DeepSeek to produce incongruent-component
  examples (Buffalo Buffalo, NY-NY Steakhouse Houston TX, Saint Petersburg FL, Paris
  Texas, mid-position postcodes, etc.) with annotated correct parses. Seeds come from
  a hand-curated category list in ``prompts.py``.

Outputs canonical JSONL rows compatible with ``corpus/src/types.ts:CanonicalRow``:

    {
      "raw": "...",
      "components": {tag: surface_form, ...},
      "country": "US"|"FR"|...,
      "locale": "en-US"|"fr-FR"|...,
      "source": "deepseek-translit-cyrl"|"deepseek-kryptonite"|...,
      "source_id": "<deterministic id>",
      "license": "Synthetic (DeepSeek-v4-flash output, AGPL-compatible)",
      "synth": {"method": "deepseek-translit:<script>", "base_source_id": "<seed source_id>"}
    }

Raw DeepSeek responses (HTTP payload bodies) are also persisted to a sidecar JSONL for
reproducibility — one line per API call with prompt + completion + usage metadata.

Checkpointing: progress is tracked at the request granularity. If interrupted, restart
with the same arguments and previously-completed batches are skipped (matched by their
deterministic batch_id). The id is derived from the batch's inputs, so a change to that
derivation invalidates every checkpoint on disk and the only symptom is a larger bill —
`tests/mailwoman_train/corpora/test_deepseek_contract.py` pins it.

The modules:

- `client.py` — the API call, the response parser, the component validator, the id function.
- `prompts.py` — the two system prompts, the script table, the adversarial category table.
- `run.py` — checkpointed concurrent execution, shared by both modes.
- `transliteration.py` / `kryptonite.py` — one mode each: what to ask for, and what to keep.
- `cli.py` — the argument parser and the mode switch.
"""

from __future__ import annotations

from .cli import main, parse_args
from .client import (
    API_URL,
    DEFAULT_MODEL,
    LICENSE_LABEL,
    deepseek_call,
    deterministic_id,
    parse_jsonl_response,
    require_api_key,
    validate_components,
)
from .kryptonite import emit_kryptonite
from .prompts import (
    KRYPTONITE_CATEGORIES,
    KRYPTONITE_SYSTEM,
    KRYPTONITE_USER_TEMPLATE,
    TRANSLIT_SCRIPTS,
    TRANSLIT_SYSTEM,
    build_kryptonite_user_prompt,
    build_translit_user_prompt,
)
from .run import Sink, load_checkpoint, run_batches
from .transliteration import TranslitBatch, emit_transliteration

__all__ = [
    "API_URL",
    "DEFAULT_MODEL",
    "KRYPTONITE_CATEGORIES",
    "KRYPTONITE_SYSTEM",
    "KRYPTONITE_USER_TEMPLATE",
    "LICENSE_LABEL",
    "TRANSLIT_SCRIPTS",
    "TRANSLIT_SYSTEM",
    "Sink",
    "TranslitBatch",
    "build_kryptonite_user_prompt",
    "build_translit_user_prompt",
    "deepseek_call",
    "deterministic_id",
    "emit_kryptonite",
    "emit_transliteration",
    "load_checkpoint",
    "main",
    "parse_args",
    "parse_jsonl_response",
    "require_api_key",
    "run_batches",
    "validate_components",
]
