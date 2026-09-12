"""What a training run does, pinned before the loop is rewritten.

`train()` had no end-to-end test: every existing test covers a part it calls, and nothing drove the
loop itself. So the four concerns woven through it — the progress print, the CSV, the periodic eval
and the checkpoint writes — could be moved without anything noticing if the order changed, an
interval stopped firing, or the optimizer trajectory shifted.

This runs a real supervised train on CPU over a two-row corpus with every interval set small enough
that each concern fires more than once, and asserts three things a rewrite must preserve:

- the CSV's shape and which rows carry val cells,
- the event order within one step, and which steps produce which events,
- the final weights, per parameter, which pins the optimizer trajectory itself.

The weight checksums come from `train-loop-reference.json` beside this file. Regenerate it with
`uv run python tests/mailwoman_train/test_train_loop_trace.py` and read the diff: a change there is
a change to what the model learns, never a formatting detail.
"""

from __future__ import annotations

import csv
import json
import re
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import torch

from mailwoman_train.config import Config, load_config
from mailwoman_train.corpora.builder import SCHEMA
from mailwoman_train.tokenizer.char import build_char_vocab, save_char_vocab
from mailwoman_train.train.trainer import train
from tests import paths

CONFIGS = paths.CONFIGS
PROBE_2K = CONFIGS / "v8-cjk-full-2k.yaml"
REFERENCE = Path(__file__).with_name("train-loop-reference.json")

#: Small enough to run on a CPU in a test, large enough that every interval fires twice and that a
#: step exists where the log, eval and save intervals coincide (step 4).
MAX_STEPS = 4
LOG_EVERY = 2
EVAL_EVERY = 2
SAVE_EVERY = 2

ROWS: list[dict[str, Any]] = [
    {
        "raw": "赵光三分场二十九队, Inner Mongolia, China",
        "tokens": ["赵", "光", "三", "分", "场", "二", "十", "九", "队", "Inner", "Mongolia", "China"],
        "labels": ["B-dependent_locality"] + ["I-locality_unit"] * 8 + ["B-region", "I-region", "B-country"],
        "span_starts": [0, 2, 11, 27],
        "span_ends": [2, 9, 25, 32],
        "span_tags": ["dependent_locality", "locality_unit", "region", "country"],
        "country": "CN",
        "source": "coarse-placer-cn-units",
        "register": "cn-units",
    },
    {
        "raw": "東京都千代田区丸の内1",
        "tokens": ["東京都千代田区丸の内1"],
        "labels": ["B-prefecture"],
        "span_starts": [0, 3, 7],
        "span_ends": [3, 7, 10],
        "span_tags": ["prefecture", "municipality", "district"],
        "country": "JP",
        "source": "overture-jp",
        "register": "native",
    },
]


def _probe_config(root: Path) -> Config:
    """The shipped probe config over a two-row corpus, shrunk to a CPU-sized run."""
    corpus = root / "corpus"
    for split in ("train", "val"):
        (corpus / split).mkdir(parents=True)
        pq.write_table(pa.Table.from_pylist(ROWS, schema=SCHEMA), corpus / split / "part-0000.parquet")
    vocab = build_char_vocab([str(row["raw"]) for row in ROWS], min_count=1)
    vocab_path = corpus / "char-vocab.json"
    save_char_vocab(vocab, vocab_path)

    cfg = load_config(PROBE_2K)
    # The shipped weights name the full corpus's sources; a two-row stand-in has none of those
    # slices, and the loader refuses a positive weight with nothing behind it. Sampling the two
    # rows uniformly is what this test wants anyway.
    cfg.data.source_weights = None
    cfg.data.corpus_dir = str(corpus)
    cfg.data.char_vocab_path = str(vocab_path)
    cfg.data.val_rows = len(ROWS)
    cfg.train.output_dir = str(root / "output")
    cfg.train.eval_batch_size = len(ROWS)
    cfg.train.batch_size = len(ROWS)
    cfg.train.max_steps = MAX_STEPS
    cfg.train.warmup_steps = 1
    cfg.train.log_every_steps = LOG_EVERY
    cfg.train.eval_every_steps = EVAL_EVERY
    cfg.train.save_every_steps = SAVE_EVERY
    return cfg


def _events(output: str) -> list[str]:
    """The loop's four concerns as an ordered list, with the wall-clock readings left out."""
    events: list[str] = []
    for line in output.splitlines():
        if match := re.match(r"step (\d+)/\d+", line):
            events.append(f"log:{match.group(1)}")
        elif line.strip().startswith("[eval]"):
            events.append("eval")
        elif match := re.search(r"\[save] checkpoint → .*step-0*(\d+)", line):
            events.append(f"save:{match.group(1)}")
    return events


def _weight_checksums(checkpoint: Path) -> dict[str, float]:
    state = torch.load(checkpoint / "pytorch_model.bin", map_location="cpu", weights_only=True)
    return {name: round(float(tensor.double().abs().sum()), 6) for name, tensor in sorted(state.items())}


def test_the_loop_emits_its_events_in_order(tmp_path: Path, capsys: Any) -> None:
    cfg = _probe_config(tmp_path)
    train(cfg)
    events = _events(capsys.readouterr().out)

    # The progress line, then the checkpoint, then the eval. The checkpoint and the eval both
    # observe the same weights at a step where their intervals coincide — the eval takes no
    # gradient — so their relative order is a property of the log, not of the run.
    assert events == ["log:2", "save:2", "eval", "log:4", "save:4", "eval"], events
    assert Path(cfg.train.output_dir, "step-000004").is_dir()


def test_the_csv_carries_a_log_row_and_an_eval_row_per_interval(tmp_path: Path) -> None:
    cfg = _probe_config(tmp_path)
    train(cfg)

    from mailwoman_train.config import csv_log_path
    from mailwoman_train.labels import resolve_label_set

    with csv_log_path(cfg).open(encoding="utf-8", newline="") as handle:
        header, *rows = list(csv.reader(handle))

    tags = resolve_label_set(cfg.data.label_set).tags
    assert header == [
        "step",
        "wall_seconds",
        "train_loss",
        "lr",
        "val_loss",
        "val_macro_f1",
        *(f"f1.{t}" for t in tags),
    ]

    # A log row leaves the val cells blank; an eval row fills them. Both exist for steps 2 and 4.
    by_kind = [(row[0], "eval" if row[4] else "log") for row in rows]
    assert by_kind == [("2", "log"), ("2", "eval"), ("4", "log"), ("4", "eval")], by_kind
    for row in rows:
        assert len(row) == len(header)


def test_the_trajectory_matches_the_pinned_weights(tmp_path: Path) -> None:
    """Per-parameter checksums of the final checkpoint.

    A rewrite that reorders the loop's concerns must not move these. A summed absolute value per
    tensor catches a changed update without storing the weights: two different trajectories agreeing
    on every tensor's absolute sum is not a case worth engineering around.
    """
    cfg = _probe_config(tmp_path)
    train(cfg)

    actual = _weight_checksums(Path(cfg.train.output_dir, f"step-{MAX_STEPS:06d}"))
    expected = json.loads(REFERENCE.read_text(encoding="utf-8"))["weight_checksums"]

    assert set(actual) == set(expected), "the parameter set moved"
    divergent = {name: (actual[name], expected[name]) for name in actual if actual[name] != expected[name]}
    assert divergent == {}, f"the optimizer trajectory moved on {len(divergent)} tensors: {divergent}"


def write_reference() -> None:
    """Regenerate `train-loop-reference.json`. Run this module directly."""
    import tempfile

    with tempfile.TemporaryDirectory() as scratch:
        cfg = _probe_config(Path(scratch))
        train(cfg)
        checksums = _weight_checksums(Path(cfg.train.output_dir, f"step-{MAX_STEPS:06d}"))

    REFERENCE.write_text(
        json.dumps(
            {
                "README": [
                    "Per-parameter absolute sums of the final checkpoint from the CPU probe run.",
                    "A moved number means the training trajectory changed, not a formatting detail.",
                    "Regenerate: uv run python tests/mailwoman_train/test_train_loop_trace.py",
                    "Fixture: _probe_config() in the test beside this file — two rows, four steps.",
                ],
                "config": PROBE_2K.name,
                "max_steps": MAX_STEPS,
                "weight_checksums": checksums,
            },
            indent="\t",
            sort_keys=False,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"wrote {REFERENCE} ({len(checksums)} tensors)")


if __name__ == "__main__":
    write_reference()
