# Vocabulary enforcement across every committed surface

**Status:** design approved 2026-09-02 (scope and landing strategy chosen by the operator).
**Supersedes the deferral recorded in** `config/vale/.vale-vocab.ini`'s header.

## The problem

`AGENTS.md` bans four words "in replies and in every committed prose surface": the three the
`AmbiguousShorthand` rule listed then, and the retired one `repo-health` already counts. Each word stands
for four or five different things, and a reader cannot tell which one a sentence means. Three Vale configs
enforce parts of that ban, and the ban covers more than they enforce:

| Surface                                                                  | Config            | Rules applied                            |
| ------------------------------------------------------------------------ | ----------------- | ---------------------------------------- |
| `docs/articles`, `docs/src/pages`, `writing-system.md`, `page-templates` | `.vale.ini`       | the full `Mailwoman` style               |
| Root interfaces, `docs/engineering`, package `README.md`                 | `.vale-vocab.ini` | `AmbiguousShorthand` only; six rules off |
| Agent replies                                                            | `.vale-chat.ini`  | `Mailwoman` + `MailwomanChat`            |
| **`.ts`, `.tsx`, `.py` comments and docstrings**                         | **none**          | **none**                                 |
| `CHANGELOG.md`, `.github/`, `scripts/` markdown                          | none              | none                                     |

The gap has two consequences, both measured at `9996e8f60`:

1. **The deferred sweep is growing.** `.vale-vocab.ini` turned six rules off because switching them
   on failed on 175 alerts, and it called the remainder "a separate sweep". Nobody scheduled that
   sweep. The same run now reports **213**.
2. **Source comments are unenforced.** 2,638 tracked `.ts`/`.tsx`/`.py` files carry **2,014**
   `AmbiguousShorthand` hits across **619** files. The only code-side vocabulary check is
   `repo-health`'s `bannedVocabulary` counter, which covers the retired word alone.

Vale reads comment prose in all three languages correctly. It extracts comments and ignores code, so the
gap is a missing config section rather than a missing tool.

## Decisions taken

**Landing strategy: one sweep, then hard enforcement.** The plan uses neither a ratchet counter nor a
per-file baseline. Every violation is fixed, and then every rule is switched on everywhere outside the
dated-records exemption. The operator chose this over a ratchet after the risk of unreviewable diffs was
stated.

**Scope: every committed prose surface.** TypeScript and TSX comments, Python docstrings and
comments, the six rules `.vale-vocab.ini` turned off, and `CHANGELOG.md` / `.github` / `scripts`.

**Exempt, unchanged:** dated point-in-time records, which are `docs/records/**` (1,488 hits) and
`docs/engineering/design/**` (6 hits, every file date-prefixed). These are historical documents. The
acronym-casing convention already exempts them, and this ban uses the same exemption.

## Why a sense census comes before any rewrite

The retired word went from 3,481 occurrences to zero only after its four concepts were given names: a
corpus recipe, a corpus recipe output, a WOF extract, and a region database. Each site then had one agreed
replacement rather than a per-site guess. `AGENTS.md` records that as the working precedent.

A per-site rewrite without a census can strip a docstring of its meaning. This repository's comments carry
invariants and measured numbers that a careless reword destroys. The census is therefore the first
deliverable.

Grouping hits by the word that modifies `check` finds 519 distinct constructions, most appearing once.
`scripts/vocab-census.ts` classifies every hit by the action it needs, and the three actions differ in
cost by an order of magnitude. Measured at `9996e8f60` over 2,638 tracked `.ts`/`.tsx`/`.py` files:

| Action         | Count | What it means                                                                                                                                                                                                                                                   | Judgement                            |
| -------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `backtick`     | 163   | The site refers to an interface-tied identifier: `@mailwoman/locale-hint`, `promotion-eval.ts`, `mailwoman eval promote`, `mwdev_promotion_eval`. Vale skips inline code, so backticks are both the fix and correct markdown.                                   | none                                 |
| `rename-check` | 956   | The modifier carries the check's real name: `street-context check` → `the street-context check`. Top modifiers: `street-context` 32, `delta` 20, `test` 19, `country` 27, `acceptance` 11, `postcode` 9, `§7-3b` 9, `existence` 8, `interval` 7, `detection` 6. | verify the modifier is the real name |
| `read-context` | 895   | The site says only "the check" / "a check". Which check it means is learnable solely from the surrounding paragraph.                                                                                                                                            | full                                 |

By word family, in the rule's listing order, the counts are 1,741, 158, 114, and one occurrence of the
retired word. That one occurrence is `scripts/repo-health.ts`'s own `BANNED_VOCABULARY` constant, which
must contain the word it counts.

This paragraph deliberately does not spell that word, for the reason its counter's docstring gives: the
ratchet is written in the language it polices, so prose that spells the word raises the count.

## Order of work

Enforcement cannot switch on until the count is zero, so the work spans more than one session. The
order below keeps every intermediate state shippable and every diff reviewable.

1. **Census, committed.** `scripts/vocab-census.ts` classifies every hit by sense and prints the
   table above. It is the measuring instrument. It must exist before any edit, so progress is read
   from a number rather than asserted.
2. **Config in report mode, without enforcement.** Add `[*.{ts,tsx}]` and `[*.py]` sections to a code
   config and widen the vocab config's path list. Run in report mode. This shows that the config sees
   what the census sees. Two independent readings of the same surface catch a false negative in either
   measuring tool.
3. **Mechanical buckets, one PR per bucket.** These are the ~145 backtick fixes and the 29 `Spelling`
   and 3 `Terms` normalizations. Every edit in one PR shares one rationale, so a reviewer checks the
   rationale once.
4. **Modifier buckets, one PR per sense.** `street-context`, `delta`, `country`, `postcode`,
   `existence`, `detection`. Each PR again has one rationale.
5. **Bare references, one PR per workspace,** heaviest first: `packages/mailwoman` (699),
   `neural` (189), `filer` (159), `resolver-wof-sqlite` (114), `core` (111), `corpus` (107),
   `dev-mcp` (97), `resolver` (90), `bdc` (73), `scripts` (59), then the tail.
6. **The 213 prose alerts,** by rule: `BannedWords` (105, mostly deletion), `Weasel` (37, each needs
   a number and a denominator), and `StockPhrases` (32).
7. **Hard enforcement.** Use one config with every rule and `MinAlertLevel = error`, wired into
   `yarn lint` and the `static` CI job. Delete the report-mode scaffolding.

## Two tensions the sweep will hit, decided here

**`source of truth` (9 hits) is flagged by `StockPhrases`,** and `AGENTS.md` uses it as interface
language: "`SCHEMA.mdx` is the single authoritative record for the `ComponentTag` union." The phrase
describes a real property: which document wins when two disagree. Keep the phrase and add it to the accept
list rather than reword nine interfaces.

**`names the` (10 hits) is flagged by `StockPhrases`,** while "name the concrete thing" is the
house instruction that the `AmbiguousShorthand` rule's own message gives. A rule that forbids the
action another rule prescribes is a rule defect. Narrow `StockPhrases` to the stock construction it
means and leave the plain verb alone.

## Verification

`docs/scripts/check-vale-rules.ts` fixture-tests the rule files. Extend it with a fixture per new
config section, so a rule that stops matching fails a test instead of producing an unexplained drop in
the count.

The census and the Vale config must agree on every count at every step. They read the same files by
different paths. A divergence means one of them is wrong, and a false negative in the measuring tool
looks identical to a real absence.
