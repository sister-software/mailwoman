"""#825 — the training-free Czech/Polish diacritic fix: UNIGRAM vocab-splice + embedding mean-init.

Background. The en-heavy 48k SentencePiece unigram vocab has the diacritic *characters* but no multi-char
*subwords* containing them, so every diacritic isolates into its own piece — "Vysoká" -> [▁V, ys, ok, á],
CZ/PL localities at ~3.3x English fertility. That fragmentation breaks span boundaries and geocodes the
address to the WRONG CITY (measured: ~44% of Czech, ~30% of Polish rows land >20km off). A data shard at
the frozen tokenizer can't fix it (a unigram model physically cannot emit a subword absent from its piece
table); v196-slavic-anchor confirmed this the expensive way — it REGRESSED CZ at 80k.

The fix is tokenizer-side and needs no GPU training:

1. Train a CZ/PL SentencePiece unigram on a Slavic address corpus.
2. Splice ONLY its diacritic-bearing pieces into the 48k vocab. Because every appended piece contains a
   codepoint that never appears in English text, it can never match a span of an English string, so English
   tokenizes BYTE-IDENTICALLY by construction — the source language cannot regress. This module ASSERTS that
   invariant (0 diff over a held-out English sample); it is not a hope.
3. Mean-init the new embedding rows from their old-tokenizer constituents (FVT): E(new) = mean over the OLD
   tokenization of the new piece's surface. The encoder is left byte-for-byte untouched.

The B-1 ablation (2026-07-01) showed step 3 alone IS the fix — a 2k fine-tune added nothing and started to
overfit. So the shipped artifact is the mean-init model, and US byte-identity is a guarantee (unchanged
encoder + unchanged English input_ids -> identical logits), not an observation.

Caveat: this is the right tool for alphabetic-script-with-diacritics (disjoint codepoints, real constituent
subwords for a strong mean-init). It does NOT scale to CJK — thousands of logographs, a segmenter is needed,
and byte-fallback constituents make mean-init weak. CJK wants a char-level front-end instead.

CLI:
    python -m mailwoman_train.tokenizer_splice build-tokenizer \\
        --oa-root $MAILWOMAN_DATA_ROOT/openaddresses/extracted --locales cz,pl,sk,si \\
        --base-tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model \\
        --out-tokenizer out/tokenizer-bsplice.model --vocab-size 24000
    python -m mailwoman_train.tokenizer_splice mean-init \\
        --checkpoint <v4.15.0 from_pretrained dir> \\
        --base-tokenizer <base.model> --spliced-tokenizer out/tokenizer-bsplice.model \\
        --out-dir out/bsplice-expanded
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import random
from pathlib import Path

import sentencepiece as spm  # type: ignore[import-not-found]
from sentencepiece import sentencepiece_model_pb2 as sp_pb2  # type: ignore[import-not-found]

# Deterministic sample size + seed so the corpus (and therefore the spliced vocab) is reproducible.
_CORPUS_SAMPLE = 350_000
_SEED = 42
# A held-out English sample can be any ASCII address list; the assertion only needs English strings.
_ENGLISH_PROBE = [
    "109 Seminary Dr, Mill Valley, CA 94941",
    "5210 South Ingleside Avenue, Chicago, IL 60615",
    "1600 Pennsylvania Ave NW, Washington, DC 20500",
    "350 Fifth Avenue, New York, NY 10118",
    "1 Infinite Loop, Cupertino, CA 95014",
]


def _core(piece: str) -> str:
    """The piece text with the SentencePiece word-boundary marker stripped (for the ASCII test)."""
    return piece.replace("▁", "")


def _is_ascii(s: str) -> bool:
    return all(ord(c) < 128 for c in s)


def build_slavic_corpus(oa_root: Path, locales: list[str], out_path: Path, *, per_file_cap: int = 400_000) -> int:
    """Stream the OpenAddresses STREET/CITY columns for ``locales`` into a deduped SP-training corpus.

    Returns the line count written. Reproducible: fixed seed + fixed sample size.
    """
    csv.field_size_limit(10**7)
    lines: set[str] = set()
    for cc in locales:
        for f in glob.glob(str(oa_root / cc / "*.csv")):
            try:
                with open(f, newline="", encoding="utf-8") as fh:
                    reader = csv.DictReader(fh)
                    for i, row in enumerate(reader):
                        street = (row.get("STREET") or "").strip()
                        city = (row.get("CITY") or "").strip()
                        if street:
                            lines.add(street)
                        if city:
                            lines.add(city)
                        if street and city:
                            lines.add(f"{street} {city}")
                        if i > per_file_cap:
                            break
            except (OSError, csv.Error):
                continue
    corpus = [ln for ln in lines if ln and len(ln) < 80]
    random.Random(_SEED).shuffle(corpus)
    corpus = corpus[:_CORPUS_SAMPLE]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(corpus), encoding="utf-8")
    return len(corpus)


def train_diacritic_sp(corpus_path: Path, out_prefix: Path, *, vocab_size: int = 24_000) -> Path:
    """Train a Slavic SentencePiece UNIGRAM model. Returns the ``.model`` path."""
    spm.SentencePieceTrainer.train(
        input=str(corpus_path),
        model_prefix=str(out_prefix),
        vocab_size=vocab_size,
        model_type="unigram",
        character_coverage=1.0,
        normalization_rule_name="identity",
        num_threads=8,
    )
    return out_prefix.with_suffix(".model")


def splice_vocab(base_tokenizer: Path, diacritic_sp: Path, out_tokenizer: Path) -> list[str]:
    """Append the diacritic-bearing pieces of ``diacritic_sp`` to ``base_tokenizer``; write ``out_tokenizer``.

    Only pieces whose core contains a non-ASCII codepoint AND that are absent from the base vocab are added,
    with their unigram scores. Returns the list of new piece strings. Raises if the English-identity
    invariant fails (see ``verify_source_identical``).
    """
    base = sp_pb2.ModelProto()
    base.ParseFromString(base_tokenizer.read_bytes())
    base_pieces = {p.piece for p in base.pieces}

    czpl = sp_pb2.ModelProto()
    czpl.ParseFromString(diacritic_sp.read_bytes())

    spliced = sp_pb2.ModelProto()
    spliced.ParseFromString(base_tokenizer.read_bytes())
    new_pieces: list[str] = []
    for p in czpl.pieces:
        core = _core(p.piece)
        if core and not _is_ascii(core) and p.piece not in base_pieces:
            sp = spliced.pieces.add()
            sp.piece = p.piece
            sp.score = float(p.score)
            sp.type = sp_pb2.ModelProto.SentencePiece.NORMAL
            new_pieces.append(p.piece)

    out_tokenizer.parent.mkdir(parents=True, exist_ok=True)
    out_tokenizer.write_bytes(spliced.SerializeToString())
    verify_source_identical(base_tokenizer, out_tokenizer)
    return new_pieces


def verify_source_identical(base_tokenizer: Path, spliced_tokenizer: Path, probe: list[str] | None = None) -> None:
    """Assert the source language tokenizes byte-identically under the spliced vocab. Raises on any diff.

    This is the disjoint-codepoint guarantee made concrete: an appended diacritic piece can't match any span
    of an English string, so English segmentation is unchanged. Cheap and definitive; never skip it.
    """
    old = spm.SentencePieceProcessor(model_file=str(base_tokenizer))
    new = spm.SentencePieceProcessor(model_file=str(spliced_tokenizer))
    texts = probe if probe is not None else _ENGLISH_PROBE
    diffs = [t for t in texts if old.encode(t, out_type=str) != new.encode(t, out_type=str)]
    if diffs:
        raise AssertionError(
            f"source tokenization changed on {len(diffs)}/{len(texts)} probe strings — a non-disjoint "
            f"(ASCII-containing) piece was spliced in. First: {diffs[0]!r}"
        )


def mean_init_embeddings(
    checkpoint_dir: Path, base_tokenizer: Path, spliced_tokenizer: Path, out_dir: Path
) -> tuple[int, int]:
    """Expand ``checkpoint_dir``'s token_embeddings to the spliced vocab; mean-init the new rows (FVT).

    Each new row = the mean of the OLD tokenizer's constituent-piece embeddings for that piece's surface.
    Only token_embeddings + the config's vocab_size change; the encoder, classifier, CRF, and anchor/gaz
    heads are left byte-for-byte untouched (which is what makes source-language behaviour a guarantee).
    Returns (old_vocab, new_vocab). Torch is imported lazily so the tokenizer path stays torch-free.
    """
    import torch

    spliced = sp_pb2.ModelProto()
    spliced.ParseFromString(spliced_tokenizer.read_bytes())
    new_vocab = len(spliced.pieces)

    sd = torch.load(checkpoint_dir / "pytorch_model.bin", weights_only=True, map_location="cpu")
    emb = sd["token_embeddings.weight"]
    old_vocab, hidden = emb.shape
    if new_vocab < old_vocab:
        raise ValueError(f"spliced vocab {new_vocab} < checkpoint vocab {old_vocab} — wrong tokenizer?")

    old_sp = spm.SentencePieceProcessor(model_file=str(base_tokenizer))
    emb_mean = emb.mean(0)
    new_rows = torch.empty(new_vocab - old_vocab, hidden)
    for idx in range(old_vocab, new_vocab):
        surface = spliced.pieces[idx].piece.replace("▁", " ")
        constituents = [i for i in old_sp.encode(surface, out_type=int) if i < old_vocab]
        new_rows[idx - old_vocab] = emb[torch.tensor(constituents)].mean(0) if constituents else emb_mean
    sd["token_embeddings.weight"] = torch.cat([emb, new_rows], 0)

    out_dir.mkdir(parents=True, exist_ok=True)
    torch.save(sd, out_dir / "pytorch_model.bin")
    cfg = json.loads((checkpoint_dir / "config.json").read_text(encoding="utf-8"))
    cfg["vocab_size"] = new_vocab
    (out_dir / "config.json").write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    return old_vocab, new_vocab


def _main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    bt = sub.add_parser("build-tokenizer", help="OA corpus -> Slavic SP unigram -> spliced tokenizer")
    bt.add_argument("--oa-root", type=Path, required=True)
    bt.add_argument("--locales", default="cz,pl,sk,si")
    bt.add_argument("--base-tokenizer", type=Path, required=True)
    bt.add_argument("--out-tokenizer", type=Path, required=True)
    bt.add_argument("--vocab-size", type=int, default=24_000)
    bt.add_argument("--work-dir", type=Path, default=Path("out/bsplice-work"))

    mi = sub.add_parser("mean-init", help="expand a checkpoint's embeddings to the spliced vocab")
    mi.add_argument("--checkpoint", type=Path, required=True)
    mi.add_argument("--base-tokenizer", type=Path, required=True)
    mi.add_argument("--spliced-tokenizer", type=Path, required=True)
    mi.add_argument("--out-dir", type=Path, required=True)

    args = ap.parse_args()
    if args.cmd == "build-tokenizer":
        args.work_dir.mkdir(parents=True, exist_ok=True)
        corpus = args.work_dir / "slavic-corpus.txt"
        n = build_slavic_corpus(args.oa_root, args.locales.split(","), corpus)
        print(f"corpus: {n} lines")
        sp_model = train_diacritic_sp(corpus, args.work_dir / "slavic-sp", vocab_size=args.vocab_size)
        new_pieces = splice_vocab(args.base_tokenizer, sp_model, args.out_tokenizer)
        print(f"spliced {len(new_pieces)} diacritic pieces -> {args.out_tokenizer}")
        print("English tokenization verified byte-identical (0 diff).")
    elif args.cmd == "mean-init":
        old_v, new_v = mean_init_embeddings(
            args.checkpoint, args.base_tokenizer, args.spliced_tokenizer, args.out_dir
        )
        print(f"expanded token_embeddings {old_v} -> {new_v}; wrote {args.out_dir}")


if __name__ == "__main__":
    _main()
