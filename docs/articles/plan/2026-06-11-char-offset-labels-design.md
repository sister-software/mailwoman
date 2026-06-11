# Char-offset labels — design sketch (2026-06-11, pre-consult draft)

Status: DESIGN. The structural cure for the class the span bridge contains. Nothing here is
committed work; the open questions at the bottom go to a DeepSeek consult and then to the
operator before anything is scheduled.

## The problem, measured

The corpus label format addresses **whitespace tokens**: `tokens[]` + `labels[]`, aligned 1:1,
with standalone punctuation dropped by the alignment tokenizer (`corpus/src/tokenize.ts` —
"maximal runs of letters/digits/marks"). Supervision is therefore **punctuation-mute**: no
training row can place a label on a character the tokenizer dropped.

What this cost, concretely:

- **The dotted-designator class** (v4.4.0 gate, battery 1): `P.O. Box` decodes as
  period-truncated fragments — 98% miss on dotted po_box leaders while the model labeled every
  letter piece correctly at 0.93+. Ten times more data moved it +2.9pp. Now contained by the
  span bridge (decode-side merge), which is containment, not cure: the bridge must GUESS which
  punctuation is intra-span (periods, hyphens) vs separator (commas) — a global heuristic where
  the data could have been the authority, per surface, per locale.
- **The comma over-merge** (battery 2): the bridge's guess was wrong for commas; six FR golden
  rows measured it. A label format that could SAY "the comma is outside both spans" makes the
  guess unnecessary.
- **The glue augmentation's ceiling**: raw-fused/tokens-split worked (#513) but only because the
  piece projection happens to align — the augmentation lives at the mercy of an encoding detail
  the format can't express directly.
- The paired-delimiter future (#518): quoted venues and parenthetical annotations cannot be
  labeled AROUND — `"Big Company HQ"` needs venue on the inner span and nothing on the quotes;
  the token format can only label the quote-bearing token whole.

## The proposal

Labels become **char ranges over `raw`**: `spans: [{start, end, tag}]` (sorted,
non-overlapping), replacing `tokens[]`+`labels[]` as the corpus's source of truth. The encode
step projects char spans onto SentencePiece pieces directly (the per-char label array that
`realign_labels_to_pieces` already builds internally — the change PROMOTES the existing internal
representation to the storage format and deletes the token-level indirection).

Properties:

- Punctuation becomes labelable (or deliberately unlabeled — both now expressible).
- `tokens[]` stays derivable for any consumer that wants it (whitespace split + span lookup);
  the reverse derivation (today's direction) is the lossy one.
- The alignment step gets SIMPLER: `alignRow` already finds components by char offset and then
  quantizes to tokens — the quantization step is deleted, not added to.
- The January Chevrotain experiment's output contract (typed char-offset spans) and Stage 2.7's
  `PhraseProposal` both become directly storable as supervision if ever wanted.

## Blast radius (the honest list)

1. **Corpus schema + every shard builder** (affix, unit, intersection, po_box/cedex, country,
   german, base adapters): emit spans instead of token labels. Mechanical per builder; the
   `synth` ancestry stamping is untouched.
2. **`encode_row` + augmentations + the relabel pass + choreography** (corpus-python): the glue
   augmentation and the #511 relabel pass re-target spans (both get SIMPLER — the relabel pass's
   builder-parity token surgery becomes char arithmetic).
3. **Audit gates**: must compare RAW-surface reconstructions (this is a feature — the dotted
   blind spot came from token-level audits).
4. **Eval golds**: unchanged ({raw, components} is already char-level by construction).
5. **The 673M-row base corpus**: needs a one-time conversion (token labels → char spans is
   LOSSLESS upward — every existing label maps to the chars its token occupies). A converter +
   spot-audit, not a re-alignment.
6. **Training invariance check**: a converted corpus must produce a BIT-IDENTICAL piece-label
   stream for rows with no intra-span punctuation (the overwhelming majority) — that is the
   regression gate for the migration itself.
7. **Unicode discipline** (consult keeper): char offsets over raw carrying é/ß/accented text are
   only meaningful under ONE normalization. The converter must assert the raw's normalization
   form matches what alignment saw (NFC throughout, verified per row) — a code-point-counting
   mismatch corrupts offsets silently, and "silently" is the operative word.
8. **The per-piece channels** (consult keeper): `realign_anchor_to_pieces` and the gazetteer
   clue painting both key off `whitespace_spans` — the migration touches their substrate, so
   each needs its OWN invariance assertion (identical channel tensors on converted rows), not
   just the label-stream gate.

## Open questions (→ consult, then operator)

1. Storage: inline `spans` column vs parallel arrays — parquet ergonomics and loader throughput.
2. Migration: big-bang conversion of v0.3.0 vs dual-format loader (reads both, converts
   token-rows on the fly) — the dual loader avoids a 673M-row rewrite but keeps two code paths
   alive indefinitely (the kind of fork that rots).
3. Does the span bridge RETIRE post-migration, or stay as a safety net at reduced scope? The
   model needs retraining on punctuation-labeled data first; the interim (new corpus, old
   model, bridge on) is eval-confounded — the consult's point stands: the first new-format
   retrain pre-registers BOTH bridge-on and bridge-off reads, with the win condition being
   dotted po_box ≥ the bridge-on baseline (89.1) with the bridge OFF, FR postcode ≥ 99.5 held,
   affix floors unchanged, and an over-merge precision floor (the failure punctuation-
   labelability could newly enable). The #518 punctuation-stress eval doubles as this retrain's
   apostrophe/slash/hyphen lens.
4. Schema versioning: this is corpus-major (v0.5.0) by any reading — what rides along
   (the DE holdout is already queued for the next base rebuild; bundling vs creeping scope).
