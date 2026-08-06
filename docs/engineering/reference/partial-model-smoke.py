"""Partial-checkpoint inference smoke test for mailwoman Stage 1.

USE: load a checkpoint, run inference on a small hand-crafted address set,
print BIO labels + decoded components + per-token confidence.

DOES NOT use the GPU — forces CPU so the running training process is not
disturbed. Loads its own model instance from the checkpoint files on disk.

Run inside the mailwoman-llm container, after a checkpoint exists at
/data/models/checkpoints/stage1-coarse/step-NNNNNN/:

    cd ~/workspace/mailwoman/packages/corpus-python
    source ~/training-venv/bin/activate
    CUDA_VISIBLE_DEVICES= HSA_OVERRIDE_GFX_VERSION= \
        python /path/to/partial-model-smoke.py \
            /data/models/checkpoints/stage1-coarse/step-005000

The CUDA_VISIBLE_DEVICES= + HSA_OVERRIDE_GFX_VERSION= prefix prevents
torch.cuda from probing the GPU; the running training process retains
exclusive ROCm access.
"""

from __future__ import annotations

import sys
from pathlib import Path

import torch

from mailwoman_train.config import Config
from mailwoman_train.labels import STAGE1_BIO_LABELS, STAGE1_COARSE_TAGS
from mailwoman_train.model import MailwomanCoarseEncoder
from mailwoman_train.tokenizer import Tokenizer
from mailwoman_train.eval import decode_components

# Ten hand-crafted addresses spanning the bitter-lesson kryptonite cases
# (Buffalo Buffalo, Saint Petersburg, NY-NY-Steakhouse) plus the easy ones.
# Format: (raw_address, expected_components) — expected is informational only;
# the smoke test does not assert it.
SMOKE_ADDRESSES: list[tuple[str, dict[str, str]]] = [
	(
		"1600 Pennsylvania Avenue NW, Washington, DC 20500, USA",
		{"region": "DC", "locality": "Washington", "postcode": "20500", "country": "USA"},
	),
	(
		"742 Evergreen Terrace, Springfield, OR 97477",
		{"region": "OR", "locality": "Springfield", "postcode": "97477"},
	),
	# Bitter-lesson kryptonite: Buffalo (NY locality) vs Buffalo (the venue prefix).
	(
		"Buffalo Health Center Inc., 200 Elmwood Ave, Buffalo, NY 14222",
		{"region": "NY", "locality": "Buffalo", "postcode": "14222"},
	),
	# Kryptonite: Saint Petersburg disambiguation (FL vs the Russian city).
	(
		"245 1st Ave N, Saint Petersburg, FL 33701",
		{"region": "FL", "locality": "Saint Petersburg", "postcode": "33701"},
	),
	# Kryptonite: New York repetition.
	(
		"The New York Steakhouse, 123 Main St, New York, NY 10001",
		{"region": "NY", "locality": "New York", "postcode": "10001"},
	),
	# French address (BAN locale).
	(
		"15 Rue de Rivoli, 75004 Paris, France",
		{"locality": "Paris", "postcode": "75004", "country": "France"},
	),
	# Rural route — currently NPPES/HRSA territory, sparse in v0.1.1.
	(
		"RR 2 Box 67, Rural Springs, MT 59101",
		{"region": "MT", "locality": "Rural Springs", "postcode": "59101"},
	),
	# PO Box.
	(
		"PO Box 1234, Anchorage, AK 99501",
		{"region": "AK", "locality": "Anchorage", "postcode": "99501"},
	),
	# Hyphenated NYC house number.
	(
		"40-12 Bell Blvd, Bayside, NY 11361",
		{"region": "NY", "locality": "Bayside", "postcode": "11361"},
	),
	# Cedex (FR postal artifact).
	(
		"BP 50001, 75321 Paris Cedex 07, France",
		{"locality": "Paris", "postcode": "75321", "country": "France", "cedex": "Cedex 07"},
	),
]

# Tokenizer pad path same as the trainer.
TOKENIZER_DIR = "/data/models/tokenizer/v0.1.0"


def run_smoke(checkpoint_dir: Path) -> None:
	print(f"=== mailwoman partial-model smoke test ===")
	print(f"checkpoint: {checkpoint_dir}")
	tokenizer = Tokenizer(Path(TOKENIZER_DIR) / "tokenizer.model")
	model = MailwomanCoarseEncoder.from_pretrained(checkpoint_dir).to("cpu")
	model.eval()
	cfg = Config()  # defaults — max_length=128 matches Stage 1 training
	print(f"vocab_size: {tokenizer.vocab_size()}  num_labels: {len(STAGE1_BIO_LABELS)}")
	print()

	for raw, expected in SMOKE_ADDRESSES:
		pieces = tokenizer.encode_with_spans(raw)
		ids = [p.piece_id for p in pieces[: cfg.data.max_length]]
		attn = [1] * len(ids)
		while len(ids) < cfg.data.max_length:
			ids.append(tokenizer.pad_id())
			attn.append(0)

		x = torch.tensor([ids], dtype=torch.long)
		m = torch.tensor([attn], dtype=torch.long)
		with torch.no_grad():
			logits = model(input_ids=x, attention_mask=m).logits[0]
		probs = torch.softmax(logits, dim=-1)
		pred_ids = probs.argmax(dim=-1).tolist()
		pred_confs = probs.max(dim=-1).values.tolist()

		real_len = min(len(pieces), cfg.data.max_length)
		pieces = pieces[:real_len]
		pred_ids = pred_ids[:real_len]
		pred_confs = pred_confs[:real_len]

		predicted = decode_components(pieces, pred_ids, raw)

		print(f"--- {raw!r}")
		print("  BIO sequence (token → label @ conf):")
		for piece, lid, conf in zip(pieces, pred_ids, pred_confs):
			label = STAGE1_BIO_LABELS[lid] if 0 <= lid < len(STAGE1_BIO_LABELS) else "?"
			print(f"    {piece.piece:>20s}  {label:<22s}  {conf:.3f}")
		print("  decoded components:")
		for tag in STAGE1_COARSE_TAGS:
			pred = predicted.get(tag, "")
			exp = expected.get(tag, "")
			mark = "✓" if pred and exp and pred.lower() == exp.lower() else ("·" if not pred and not exp else "✗")
			print(f"    {mark} {tag:<22s} pred={pred!r:30s} expected={exp!r}")
		print()


if __name__ == "__main__":
	if len(sys.argv) != 2:
		print("usage: partial-model-smoke.py <checkpoint-dir>", file=sys.stderr)
		sys.exit(2)
	run_smoke(Path(sys.argv[1]))
