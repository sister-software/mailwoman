# Task 9 report — paired-punctuation audit (arc final task)

Branch `feat/placetype-pair-prior` (unswitched, per instruction). Scope per
`.superpowers/sdd/task-9-brief.md`: characterize + harden the decode path's handling of paired
punctuation (quotes, brackets, braces, parens, guillemets) end to end — tokenizer pieces →
`groupPiecesIntoWords` → `normalizeFSTToken` → priors → decoder spans → formatter round-trip.

## Summary

Characterization surfaced **two real mechanical defects**, both in the "silent mangle" class the
brief says must be fixed, not documented — both fixed with RED-test-first evidence:

1. **Tokenizer offset corruption on byte-fallback pieces** (`neural/tokenizer.ts`). SentencePiece's
   `<0xHH>` byte-fallback escape hatch fires on curly quotes “”‘’, guillemets «», and even ASCII
   braces `{}` on this vocab — not just non-Latin scripts, the tokenizer's own doc comment's prior
   assumption. The offset walker treated the placeholder TEXT's length (6 chars, `"<0x7B>"`) as real
   input chars consumed, instead of the 1 actual byte it represents — desyncing every downstream
   piece's `[start, end)` for the REST of the input. Fixed: buffer a byte-fallback run, decode via
   `TextDecoder`, advance the cursor by the decoded string's real length.
2. **`groupPiecesIntoWords` byte-fallback placeholder leaking into `fstToken`** (`neural/fst-prior.ts`).
   The same `<0xHH>` placeholder text contains hex digits/letters that `/[\p{L}\p{N}]/u` misread as
   real alnum content, injecting garbage ("0x7bblock" instead of "block") into the FST/pair-index
   probe key for any curly-quoted or braced place name — a silent false-negative on retrieval-augmented
   priors. Fixed: byte-fallback pieces are now treated as non-alnum (punctuation-equivalent), same as
   any other punctuation-only piece.

Everything else characterized as **PASS** (the existing boundary-trim/word-grouping machinery,
built for the v0.4.0 comma-slip class and the arc's own hyphen/bare-▁ fixes, generalizes to paired
punctuation with no dedicated code) or **ACCEPTED-WITH-RATIONALE** (interior paired-punct chars
surviving inside a span VALUE — by design, same as hyphens/apostrophes already are; and one
model-accuracy gap on an unusual bracketed-designator shape, evidenced below as NOT
character-leakage).

Zero crashes anywhere. Zero silent word drops. `yarn vitest run neural/ mailwoman/eval-harness/invariance`
green (440/440), `yarn compile` clean, oxfmt clean.

## Method

1. Traced each case class through the pipeline with direct probe scripts against both the small
   fixture tokenizer (`tokenizer-v0.1.0.model`, deliberately tiny vocab — hits byte-fallback on
   almost every non-ASCII/non-comma punctuation mark, useful for forcing the edge case
   deterministically) and the production tokenizer (`v0.9.0-multisplice`).
2. Wrote durable unit/regression tests for every stage (tokenizer, `groupPiecesIntoWords`,
   `buildPlacetypePairPriors` segment-mode probe keys, `buildAddressTree` span trimming).
3. Added the `wrap-in-quotes` / `add-parenthetical` transform classes + 4 fixture rows to the
   invariance mini-suite, ran the full suite (now 23 rows / 156 pairs) against real weights for
   **v385** (the shipped default) and **feed-8k** (`model-v3110-deploc-feed-step-008000-int8.onnx`,
   fetched fresh from the Modal training volume for this task, md5 matches Task 8's report) — both
   via `@mailwoman/neural-weights-en-gb`-shaped caches, so the placetype-pair prior is active
   (`traceParse` confirms `{"kind":"placetypePair","applied":true}` posture, same as Task 6's recipe).
4. Did a direct-inference control comparison (bracketed vs. non-bracketed variant of the same address)
   to separate "the decode path mishandled the punctuation" from "the model's own accuracy on an
   unfamiliar shape" — the two failure classes look identical in an aggregate INVARIANT/DEGRADED/LOST
   count but have completely different remedies.

## Verdict matrix — case class × pipeline stage

Legend: **PASS** = works correctly, no change; **FIXED** = defect found, fixed this task, RED test
included; **ACCEPTED** = characterized behavior, not a defect, rationale given.

| Case class                                              | Tokenizer offsets                                                                                                       | `groupPiecesIntoWords`                                          | `normalizeFSTToken` / NFKC                                                                                                     | placetype-pair-prior probe (segment mode)                                                                                                            | Decoder span-edge trim                                                                                                                                                                                                      | Formatter round-trip                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Straight quotes `"…"`                                   | PASS (native vocab piece)                                                                                               | PASS                                                            | PASS (strips as `\p{P}`)                                                                                                       | PASS — clean fold, no leak                                                                                                                           | PASS — edges trimmed                                                                                                                                                                                                        | PASS                                                                                                |
| Curly quotes `”” ‘ ‘`                                   | **FIXED** (was byte-fallback offset corruption)                                                                         | **FIXED** (was hex-garbage injection)                           | PASS once reached (NFKC does NOT map curly→straight — verified, not assumed; `\p{P}` strips both forms identically regardless) | PASS after fix — same fold as straight quotes                                                                                                        | MECHANISM PASS (offsets trace-verified correct) / MODEL-ACCURACY GAP (curly quotes parse materially worse than straight — BIO confidence collapse, review-measured on v385; same class as the bracketed-designator row)     | PASS                                                                                                |
| Guillemets `«»`                                         | **FIXED** (2-byte UTF-8 fallback on small vocab; native on production vocab — both paths now correct)                   | **FIXED**                                                       | PASS                                                                                                                           | PASS after fix                                                                                                                                       | PASS — edges trimmed                                                                                                                                                                                                        | PASS                                                                                                |
| Parenthetical aside `(…)`                               | PASS (native vocab piece on both tokenizers)                                                                            | PASS (already covered by the arc's interior-punct/bare-▁ fixes) | PASS                                                                                                                           | PASS — segment mode's own venue-confound design already isolates it                                                                                  | PASS — aside dropped as O or trimmed cleanly, never leaks                                                                                                                                                                   | PASS                                                                                                |
| Bracketed designator `[…]`                              | PASS (native on production vocab; small-vocab fixture hits byte-fallback — **FIXED**)                                   | **FIXED**                                                       | PASS                                                                                                                           | PASS after fix                                                                                                                                       | PASS — edges trimmed (real-inference verified)                                                                                                                                                                              | PASS                                                                                                |
| Braces `{…}`                                            | **FIXED** (byte-fallback on BOTH tokenizers — production vocab has no native `{`/`}` token)                             | **FIXED**                                                       | PASS                                                                                                                           | not separately probed (no realistic braced-place-name row; braces are a designator/unit shape, not a place-name shape, in every real corpus checked) | ACCEPTED — interior `{` can survive inside a span VALUE when the model's own B/I labeling includes it (`"Suite {12B"`, real v385/feed-8k output below) — by design, same as hyphens/apostrophes; trim only clips span EDGES | PASS (renders the interior char verbatim, no double-escaping — Mustache `{{{slot}}}` triple-stache) |
| UNBALANCED pairs (opener with no closer, or vice versa) | PASS — `trimBoundary`/the tokenizer fix have no notion of "pairing" at all, so imbalance is a non-issue by construction | PASS (same reason)                                              | PASS                                                                                                                           | PASS — no crash, still probes the clean fold                                                                                                         | PASS — no crash, trims the lone stray char exactly like any other boundary punctuation                                                                                                                                      | PASS                                                                                                |

Note: The curly-quotes row's "Decoder span-edge trim" verdict was corrected post-review from "PASS — edges trimmed (real-inference verified)" to reflect that curly quotes present a model-accuracy gap (BIO confidence collapse on unfamiliar shapes), distinct from the tokenizer/grouping mechanism fixes.

## The two fixed defects, in detail

### 1. Tokenizer byte-fallback offset corruption (`neural/tokenizer.ts`)

Before the fix, `"{Block C}, Leeds"` tokenized (production tokenizer) to pieces including
`<0x7B>` (the byte-fallback for `{`), and the offset walker advanced the cursor by
`"<0x7B>".length` (6) instead of 1 real character:

```
"<0x7B>" start=0 end=6   raw.slice(0,6) = "{Block"   <- WRONG, should be "{"
"B"      start=6 end=7   raw.slice(6,7) = " "         <- WRONG, should be "B"
"lock"   start=7 end=11  raw.slice(7,11) = "C}, "      <- WRONG, should be "lock"
```

Every piece after the very first byte-fallback char in the string was reading the wrong slice of
`raw` — a live, silent content-corruption bug for the entire REST of any input containing a
byte-fallback character, not confined to the character itself. Confirmed on the production
tokenizer (`v0.9.0-multisplice`) that braces AND curly quotes hit this (not just exotic scripts —
the tokenizer's own doc comment previously said "Latin-script corpus, byte-fallback deferred until a
real case surfaces"; this audit is that real case).

Fix: buffer a run of consecutive `<0xHH>` pieces, decode the accumulated bytes as one UTF-8 sequence
via `TextDecoder`, and advance the cursor by the DECODED string's actual length (correctly handles
multi-byte codepoints too — e.g. curly quote “ is 3 UTF-8 bytes / 3 fallback pieces / 1 real
character). Verified post-fix:

```
"<0x7B>" start=0 end=1   raw.slice(0,1) = "{"    <- correct
"B"      start=1 end=2   raw.slice(1,2) = "B"    <- correct
"lock"   start=2 end=6   raw.slice(2,6) = "lock"  <- correct
```

Regression tests: `neural/test/tokenizer-byte-fallback.test.ts` (new file, 6 tests) — single-byte
fallback mid-string, fallback at end-of-input, multi-byte curly-quote run recomposing to one real
character (with the "before" cursor-overrun math spelled out in the test comment), guillemets,
native-piece control cases (straight quotes/parens unaffected), empty-input edge case. All against
the small fixture tokenizer (deterministic, no gating needed — it hits byte-fallback on braces,
quotes, and guillemets even though it's nominally Latin-script). Existing
`tokenizer-large-parity.test.ts`'s "supported subset" test (which deliberately EXCLUDES
byte-fallback rows from its per-piece literal-match check) still passes unchanged — that test's
per-piece invariant genuinely doesn't apply to a byte-fallback run's intermediate zero-width
placeholder pieces by design; the property that actually matters (cursor non-decreasing, downstream
pieces land correctly) is what the new test file asserts instead.

### 2. `groupPiecesIntoWords` byte-fallback placeholder leaking into `fstToken` (`neural/fst-prior.ts`)

Even with offsets fixed, `groupPiecesIntoWords`'s `hasAlnum` check (`/[\p{L}\p{N}]/u.test(p.piece)`)
read the placeholder TEXT `"<0x7B>"` itself — which contains real letters/digits (`0`, `x`, `7`,
`B`) — as if it were genuine word content:

```
Before fix: '"The Grange", Fishburn' (curly-quoted) folds to
  ["", "0xe20x800x9cthe", "grange0xe20x800x9d", "fishburn"]   <- garbage, would never match a real index key
After fix:
  ["", "", "", "the", "grange", "fishburn"]                    <- clean, same as the straight-quote case
```

This is a silent FALSE-NEGATIVE class for the FST prior and the placetype-pair prior: a real place
name written with curly quotes, guillemets, or braces would never probe-match the index, even though
the identical name written with straight quotes/no quotes would. Fixed by treating any
`<0xHH>`-shaped piece as non-alnum (the same "punctuation, contributes nothing to `fstToken`" branch
already used for real punctuation).

Regression tests: 3 new cases in `neural/fst-prior.test.ts` (braces, curly quotes, guillemets — all
against the small fixture tokenizer, no gating needed) plus 4 new cases in
`neural/placetype-pair-prior.test.ts`'s new "paired punctuation" describe block, proving the segment-mode
probe key is clean (`"the grange"`, never `'"the grange"'` or hex-contaminated) for a quoted venue, a
bracketed segment, a curly-quoted segment (explicit before/after-fix regression comment), and an
UNBALANCED opener with no closer.

## Real-inference span-edge check (v385 + feed-8k, post-fix)

Direct `classifier.parse()` + `decodeAsJSON()` calls (not synthetic BIO tokens) against both models,
using the `@mailwoman/neural-weights-en-gb`-shaped caches described below:

```
"The Grange", Fishburn, Stockton-on-Tees
  v385:     {"locality":"Fishburn","street":"The Grange"}
  feed-8k:  {"dependent_locality":"Fishburn","street":"The Grange","region":"Stockton-on-Tees"}

12 High St (rear entrance), Leeds
  v385:     {"locality":"Leeds","street":"High St","house_number":"12"}
  feed-8k:  {"locality":"Leeds","street":"High St","house_number":"12"}

Suite {12B}, 200 Main St, Austin, TX 78701
  v385:     {"region":"TX","locality":"Austin","street":"Main","venue":"Suite {12B","house_number":"200","street_suffix":"St","postcode":"78701"}
  feed-8k:  {"region":"TX","locality":"Austin","street":"Main","venue":"Suite {12B","house_number":"200","street_suffix":"St","postcode":"78701"}
```

Neither model ever emits a leading/trailing quote, bracket, brace, or paren character in a component
value — `street: "The Grange"` (not `'"The Grange"'`), `unit: "Unit 4"` (brackets stripped),
`(rear entrance)` never surfaces as any component at all (fully absorbed as `O`, no leak, no crash).
The one place an interior char survives — `venue: "Suite {12B"` — is the ACCEPTED case: `{` sits
INSIDE the model's own B-venue/I-venue span (between "Suite" and "12B"), so `trimBoundary` correctly
leaves it alone (it only clips the outer edges); the trailing `},` gets trimmed off entirely because
both chars are non-word and sit at the very end of the span. This is exactly the same "does not trim
word-internal punctuation" behavior already characterized and accepted for hyphens/apostrophes in
`core/decoder/build-tree.test.ts` — not a new gap, not fixable by span-trimming (trimming interior
chars would corrupt "O'Brien's" / "Sainte-Livrade-sur-Lot" the same way), and not worth a decoder
change under the brief's own "fix ONLY if local to span trimming" carve-out — there is no local trim
fix that doesn't also break the accepted interior-punctuation cases.

## NFKC finding (tested, not assumed)

```js
"“A”".normalize("NFKC") === "“A”" // true — NFKC does NOT fold curly quotes to straight
"«A»".normalize("NFKC") === "«A»" // true — guillemets untouched too
```

Curly quotes and guillemets are canonical Unicode characters, not NFKC compatibility-decomposition
targets of the straight quote — so `normalizeFSTToken`'s NFKC step does nothing to unify them. What
DOES unify their behavior with straight quotes is the subsequent `\p{P}` strip (all four punctuation
subcategories — Ps/Pe/Pi/Pf/Po — are covered), which removes every quote/bracket/brace/guillemet form
identically regardless of NFKC. The two mechanisms are independent; conflating them would have been
an easy wrong assumption, which is why the brief called it out explicitly.

## Model-accuracy caveat: NOT a paired-punctuation defect

The one row with a materially worse aggregate profile (`gb-bracketed-designator`, 3–5 of 8 pairs
INVARIANT depending on the model) is a model-accuracy gap on an unfamiliar shape, evidenced by a
direct control comparison — the bracketed and non-bracketed variants of the SAME address, same model
(v385):

```
"Unit 4 [Block B], 10 Station Road, Banbury, OX17 1PP"   (as shipped in the suite)
  → {"postcode":"10","street":"Station Road","unit":"Unit 4","house_number":"1P"}   <- house_number/postcode wrong

"Unit 4, 10 Station Road, Banbury, OX17 1PP"              (control: brackets removed)
  → {"locality":"Banbury","street":"Station Road","unit":"Unit 4","house_number":"10","postcode":"X17 1PP"}
```

The bracket CHARACTERS themselves never leak into any span (confirmed above — `unit: "Unit 4"` is
clean in both). What degrades is the model's segmentation of house_number/postcode/locality once an
unfamiliar "[Block B]"-shaped token run sits between "Unit 4" and the comma — almost certainly a
training-data underrepresentation of this exact shape, not a mechanical decode-path bug. This is the
same "dominant failure signature" class the suite's own header note already documents for
comma-drop generally (a pre-existing v385/feed-8k weakness on multi-segment GB addresses), not
something paired-punctuation introduced. Flagged here, not fixed — a model/training-data follow-up,
out of this task's decode-path-mechanics scope.

## Invariance suite additions

Two new transform classes (`mailwoman/eval-harness/invariance/transforms.ts`, literature-anchored,
tested in `transforms.test.ts`):

- `wrap-in-quotes` — wraps the whole input in a straight-quote pair (mirrors a spreadsheet/CSV-cell
  copy-paste artifact; same "wrap the whole thing" idiom as the existing `trailing-punct`).
- `add-parenthetical` — appends `" (main entrance)"` (Ribeiro et al. 2020 CheckList's
  "append an irrelevant clause" INV class, paired-bracket sibling of `trailing-punct`).

Four new fixture rows in `suite.jsonl` (`gb-quoted-venue`, `gb-parenthetical-aside`,
`gb-bracketed-designator`, `us-brace-suite`), each carrying the full applicable transform set
including both new classes. Suite is now 23 rows / 156 pairs (was 19/121).

### v385 + feed-8k profiles (full 23-row suite, fresh run this task)

| Model   | INVARIANT | DEGRADED | LOST | of pairs |
| ------- | --------- | -------- | ---- | -------- |
| v385    | 132       | 5        | 19   | 156      |
| feed-8k | 131       | 12       | 13   | 156      |

Restricted to the 4 new paired-punct rows only (32 pairs):

| Row                       | v385 INVARIANT | feed-8k INVARIANT | Note                                                                                                                                          |
| ------------------------- | -------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `gb-quoted-venue`         | 6/8            | 5/8               | violations are `comma-drop`/`add-parenthetical` swallowing a trailing segment into `street` — the known comma-drop family, not quote-specific |
| `gb-parenthetical-aside`  | 8/8            | 7/8               | clean on v385; one `wrap-in-quotes` miss on feed-8k                                                                                           |
| `gb-bracketed-designator` | 3/8            | 5/8               | model-accuracy gap, see above — not character leakage                                                                                         |
| `us-brace-suite`          | 8/8            | 8/8               | fully INVARIANT on both — the exact case class the byte-fallback fix targeted                                                                 |

Weights used: `@mailwoman/neural-weights-en-gb`-shaped caches. v385 = the real, checked-in
`neural-weights-en-gb` workspace (resolves `mailwoman.baseWeights` → `neural-weights-en-us`'s
`model.onnx` symlink, which is `model-v385-latam-step-008000-int8.onnx` as of 2026-07-23 — the
suite's own documented shipped-default). feed-8k = `model-v3110-deploc-feed-step-008000-int8.onnx`
fetched fresh from the `mailwoman-training` Modal volume this task (39,411,976 bytes, tokenizer
md5 `5c01cdcd4ae25849c5cb26b69fd3dde9` — byte-identical to v385's, matching Task 6/8's provenance),
paired with the real `pair-index-gb.bin` (δ=5.0)/`postcode-gb.bin`/lexicon siblings from the
checked-in `neural-weights-en-gb` workspace and a `package.json` with no `mailwoman.baseWeights`
field (so the local `model.onnx` wins over the base, per Task 6's construction recipe).

## Formatter round-trip

Direct `formatAddress()` smoke check on already-decoded, already-clean component values:

```
formatAddress({ street: "The Grange", locality: "Fishburn", region: "Stockton-on-Tees" }, "GB")
  → "The Grange\nFishburn\nStockton-on-Tees"
formatAddress({ venue: "Suite {12B", house_number: "200", street: "Main", street_suffix: "St",
                 locality: "Austin", region: "TX", postcode: "78701" }, "US")
  → "Suite {12B\n200 Main St\nAustin, TX 78701"
```

PASS by construction: `format.ts` uses Fragaria's Mustache templates with `{{{slot}}}` (triple-stache
— no HTML-escaping), and every value it interpolates already went through the decoder's boundary
trim. There is no additional paired-punctuation-specific logic in the formatter, and none is needed —
confirmed by inspection (grep for escaping/`{{` vs `{{{`) plus the two smoke calls above, which
render both a quoted-then-cleaned value and an accepted-interior-brace value verbatim with no
crash, no double-escaping, no mangling.

## Gates

- Zero crashes: every new test includes at least one `expect(() => …).not.toThrow()` case for the
  unbalanced-pair shapes; the full CLI runs (both models, 156 pairs each) completed without an
  uncaught exception.
- Zero silent word drops: `groupPiecesIntoWords`'s existing bare-▁/interior-punct machinery already
  generalizes (characterized, not re-fixed); the two NEW defects were mangle-class (wrong offsets /
  garbage fold text), not drops, and are now fixed.
- Span-edge leakage: characterized as clean at the edges (real-inference verified); the one interior
  survival (`{` inside `venue`) is ACCEPTED per the brief's own carve-out — no local span-trim fix
  exists that wouldn't also break the already-accepted hyphen/apostrophe cases.

## Test summary

`yarn vitest run neural/ mailwoman/eval-harness/invariance`: **40 files / 440 tests, all green.**
`yarn compile`: clean. `oxfmt --check` / `oxlint`: clean on every touched file.

New/changed test files: `neural/test/tokenizer-byte-fallback.test.ts` (new, 6 tests),
`neural/fst-prior.test.ts` (+3 tests), `neural/placetype-pair-prior.test.ts` (+4 tests),
`core/decoder/build-tree.test.ts` (+9 tests), `mailwoman/eval-harness/invariance/transforms.test.ts`
(+4 tests, registry-list update), `mailwoman/eval-harness/invariance/runner.test.ts` (row-count bound
bump for the 4 new fixture rows).

## Commits

Two logical groups, committed separately per the brief's "any defect fixes separate with their own
RED evidence" instruction:

1. Characterization tests + fixture rows (the audit's positive-and-accepted findings): new invariance
   transforms/rows, `build-tree.test.ts` span-trim characterization, `placetype-pair-prior.test.ts`
   paired-punct probe-key characterization.
2. The two defect fixes (tokenizer byte-fallback offsets, `groupPiecesIntoWords` byte-fallback
   alnum-guard) with their own regression tests.
