# Vocabulary enforcement across every committed surface

**Status:** design approved 2026-09-02 (scope and landing strategy chosen by the operator).
**Supersedes the deferral recorded in** `docs/.vale-vocab.ini`'s header.

## The problem

`AGENTS.md` states that four words — `gate`, `shard`, `seam`, `cut` — are banned "in replies AND in
every committed prose surface", because each stands for four or five different things and a reader
cannot tell which one a sentence means. Three Vale configs enforce parts of that claim, and the
claim is wider than the enforcement:

| Surface                                                                  | Config            | Rules applied                            |
| ------------------------------------------------------------------------ | ----------------- | ---------------------------------------- |
| `docs/articles`, `docs/src/pages`, `writing-system.md`, `page-templates` | `.vale.ini`       | the full `Mailwoman` style               |
| Root contracts, `docs/engineering`, package `README.md`                  | `.vale-vocab.ini` | `AmbiguousShorthand` only; six rules off |
| Agent replies                                                            | `.vale-chat.ini`  | `Mailwoman` + `MailwomanChat`            |
| **`.ts`, `.tsx`, `.py` comments and docstrings**                         | **none**          | **none**                                 |
| `CHANGELOG.md`, `.github/`, `scripts/` markdown                          | none              | none                                     |

Two consequences, both measured at `9996e8f60`:

1. **The deferred sweep is growing.** `.vale-vocab.ini` turned six rules off because switching them
   on failed on 175 alerts, and called the remainder "a separate sweep". Nothing scheduled it. The
   same run now reports **213**.
2. **Source comments are unenforced.** 2,638 tracked `.ts`/`.tsx`/`.py` files carry **2,014**
   `AmbiguousShorthand` hits across **619** files. The only code-side vocabulary check is
   `repo-health`'s `bannedVocabulary` counter, which covers the retired `shard` family alone.

Vale reads comment prose in all three languages correctly — it extracts comments and ignores code —
so the gap is a missing config section, not a missing tool.

## Decisions taken

**Landing strategy: one sweep, then hard enforcement.** No ratchet counter, no per-file baseline.
Every violation is fixed, then every rule is switched on everywhere outside the dated-records
exemption. The operator chose this over a ratchet with the unreviewable-diff risk stated.

**Scope: every committed prose surface.** TypeScript and TSX comments, Python docstrings and
comments, the six rules `.vale-vocab.ini` turned off, and `CHANGELOG.md` / `.github` / `scripts`.

**Exempt, unchanged:** dated point-in-time records — `docs/records/**` (1,488 hits) and
`docs/engineering/design/**` (6 hits, every file date-prefixed). These are historical documents;
the acronym-casing convention already exempts them and this ban follows the same line.

## Why a sense census comes before any rewrite

`shard` reached zero occurrences from 3,481 only after its four concepts were named — a corpus
recipe, a corpus slice, a WOF extract, a region database — so each site had one agreed replacement
rather than a per-site guess. `AGENTS.md` records that as the working precedent.

A per-site rewrite with no census is how a docstring loses its meaning, and this repository's
comments carry invariants and measured numbers that a careless reword destroys. The census is
therefore the first deliverable, not documentation of one.

Censusing by the word that modifies `gate` finds 519 distinct constructions, most appearing once.
`scripts/vocab-census.ts` classifies every hit by the REMEDY it needs, and the three remedies differ
in cost by an order of magnitude. Measured at `9996e8f60` over 2,638 tracked `.ts`/`.tsx`/`.py`
files:

| Remedy         | Count | What it means                                                                                                                                                                                                                                                  | Judgement                            |
| -------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `backtick`     | 163   | The site names a contract-bearing identifier — `@mailwoman/locale-gate`, `promotion-gate.ts`, `mailwoman eval gate`, `mwdev_gate`. Vale skips inline code, so backticks are both the fix and correct markdown.                                                 | none                                 |
| `rename-check` | 956   | The modifier carries the check's real name: `street-context gate` → `the street-context check`. Top modifiers: `street-context` 32, `delta` 20, `test` 19, `country` 27, `acceptance` 11, `postcode` 9, `§7-3b` 9, `existence` 8, `interval` 7, `detection` 6. | verify the modifier is the real name |
| `read-context` | 895   | The site says only "the gate" / "a gate". Which check it means is learnable solely from the surrounding paragraph.                                                                                                                                             | full                                 |

By word family: `gate` 1,741, `seam` 158, `cut` 114, `shard` 1. The single `shard` is
`scripts/repo-health.ts`'s own `BANNED_VOCABULARY` constant, which necessarily contains the word it
counts.

## Order of work

Enforcement cannot switch on until the count is zero, so the arc spans more than one session. The
order below keeps every intermediate state shippable and every diff reviewable.

1. **Census, committed.** `scripts/vocab-census.ts` classifies every hit by sense and prints the
   table above. It is the measuring instrument; it must exist before any edit, so progress is read
   from a number rather than asserted.
2. **Config, not yet enforcing.** Add `[*.{ts,tsx}]` and `[*.py]` sections to a code config and
   widen the vocab config's path list. Run in report mode. This proves the config sees what the
   census sees — two independent readings of the same surface, which is how a false negative in the
   measuring tool gets caught.
3. **Mechanical buckets, one PR per bucket.** The ~145 backtick fixes; the 29 `Spelling` and 3
   `Terms` normalizations. Every edit in one PR shares one rationale, so a reviewer checks the
   rationale once.
4. **Modifier buckets, one PR per sense.** `street-context`, `delta`, `country`, `postcode`,
   `existence`, `detection`. Same property: one rationale per PR.
5. **Bare references, one PR per workspace,** heaviest first: `packages/mailwoman` (699),
   `neural` (189), `filer` (159), `resolver-wof-sqlite` (114), `core` (111), `corpus` (107),
   `dev-mcp` (97), `resolver` (90), `bdc` (73), `scripts` (59), then the tail.
6. **The 213 prose alerts,** by rule: `BannedWords` (105, mostly deletion), `Weasel` (37, each needs
   a number and a denominator), `StockPhrases` (32).
7. **Hard enforcement.** One config, every rule, `MinAlertLevel = error`, wired into `yarn lint` and
   the `static` CI job. Delete the report-mode scaffolding.

## Two tensions the sweep will hit, decided here

**`source of truth` (9 hits) is flagged by `StockPhrases`,** and `AGENTS.md` uses it as contract
language: "`SCHEMA.mdx` is the single source of truth for the `ComponentTag` union." The phrase names
a real property — which document wins when two disagree. Keep the phrase; add it to the accept list
rather than reword nine contracts.

**`names the` (10 hits) is flagged by `StockPhrases`,** while "name the concrete thing" is the
house instruction that the `AmbiguousShorthand` rule's own message gives. A rule that forbids the
remedy another rule prescribes is a rule defect. Narrow `StockPhrases` to the stock construction it
means and leave the plain verb alone.

## Verification

`docs/scripts/check-vale-rules.ts` fixture-tests the rule files. Extend it with a fixture per new
config section, so a rule that stops matching is caught by a failing test rather than by a silently
falling count.

The census and the Vale config must agree on every count at every step. They read the same files by
different paths; a divergence means one of them is wrong, and a false negative in the measuring tool
is indistinguishable from real absence.
