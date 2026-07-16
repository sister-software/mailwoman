"""B4c — splice word-start number pieces (10..9999) into v0.9.0-multisplice.

Unlike the diacritic splice, number pieces INTENTIONALLY change how numbers tokenize (that's the
fix: `178` -> one piece, zero postcode-leaning continuations). So the invariant is NOT full English
byte-identity — it is: (a) numbers 10-9999 become single pieces, (b) English LETTERS are untouched
(only numeric spans change). 5-digit+ stays multi-piece (unambiguously postcode-length).

Score: flat -12.5, matching the existing learned 2-digit pieces (▁16 = -12.73). That handily beats
the sum-of-digit-constituents (~-34 to -40), so the single piece always wins the unigram segmentation.
"""
import sys
from pathlib import Path

sys.path.insert(0, "corpus-python/src")
import sentencepiece as spm

try:
    from sentencepiece import sentencepiece_model_pb2 as pb2
except Exception:
    from mailwoman_train.tokenizer_splice import sp_pb2 as pb2

BASE = Path("/mnt/playpen/mailwoman-data/models/tokenizer/v0.9.0-multisplice/tokenizer.model")
OUT = Path("/mnt/playpen/mailwoman-data/models/tokenizer/v0.11.0-numsplice/tokenizer.model")
OUT.parent.mkdir(parents=True, exist_ok=True)

m = pb2.ModelProto()
m.ParseFromString(BASE.read_bytes())
existing = {p.piece for p in m.pieces}
base_n = len(m.pieces)

added = 0
for n in range(10, 10000):  # 2-4 digit word-start; 5-digit+ stays multi-piece (postcode-length)
    piece = f"▁{n}"  # ▁<n>
    if piece in existing:
        continue
    sp = m.pieces.add()
    sp.piece = piece
    sp.score = -12.5
    sp.type = pb2.ModelProto.SentencePiece.NORMAL
    added += 1

OUT.write_bytes(m.SerializeToString())
print(f"base vocab {base_n} + {added} number pieces = {len(m.pieces)} (+{100*added/base_n:.1f}%)")

# --- verify ---
new = spm.SentencePieceProcessor(model_file=str(OUT))
old = spm.SentencePieceProcessor(model_file=str(BASE))
print("\n(a) numbers now single-piece:")
for x in ["178", "121", "1234", "44", "16", "90210", "9"]:
    print(f"  {x:>6} -> {new.encode_as_pieces(x)}")
print("\n(b) English LETTERS untouched (non-numeric strings byte-identical):")
ok = True
for s in ["Hallingrudveien", "aleja Wojska Polskiego", "Main Street", "Rue Montmartre", "New York NY"]:
    o, nn = old.encode_as_pieces(s), new.encode_as_pieces(s)
    same = o == nn
    ok = ok and same
    print(f"  {'✓' if same else '✗ CHANGED'} {s!r}")
print("\n(c) contextful address — only the number span changes:")
for s in ["aleja Wojska Polskiego 178", "Hallingrudveien 32, 3370 Vikersund"]:
    print(f"  OLD {s!r}: {old.encode_as_pieces(s)}")
    print(f"  NEW {s!r}: {new.encode_as_pieces(s)}")
print("\nLETTERS-INTACT:", ok)
