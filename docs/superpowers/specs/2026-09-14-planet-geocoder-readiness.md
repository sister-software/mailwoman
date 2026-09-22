# Planet geocoder — what the checkout can and cannot say

A readiness survey taken from the checkout, with no board run. The per-country gazetteer section is the one
exception and says so in place: it came through the `mailwoman-dev` daemon, which has the data root. Every other number here
is reproducible from tracked files; where a question needs `candidate.db` or the regression board it is named as
unanswered rather than estimated.

The question behind it: mailwoman's release list ships eleven locales, and the repository's own tables, guards and
boards were built when it shipped two. This records where those have kept up and where they have not.

## What the repository claims, by three different registers

| Register       | Says                                                                                                                       | Source                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Locale tiers   | tier 1 **US, FR**; tier 2 IT PT PL AT CZ DE AU BE ES NL CH HR DK FI; tier 3 NO SE; tier 4 CZ PL SK SI; tier 5 **JP KR CN** | `docs/engineering/SCOPE.mdx`                                 |
| Release list   | eleven locales over eleven countries — AU CN DE ES FR GB IN IT JP NZ US                                                    | `release.config.json` (`locales` + `charWeights[].overlays`) |
| Country tables | 35 country sets across 29 files, each its own subset                                                                       | measured, below                                              |

The three do not agree, and they are not meant to identically. A tier is a claim about measurement, the release
list is a claim about artifacts, a table is a claim about one mechanism. What follows is the places where they
contradict rather than merely differ.

## The board cannot see most of the planet

Every committed gauntlet case, counted per country:

```
208 case files, 130 countries, 1,261 rows
median rows per country          2
countries with exactly one row   59 of 130
rows in the eleven shipping countries   455 of 1,261
```

**Not every row checks.** `mailwoman data coverage`'s docstring draws the distinction — "a board row that is not
`status: pass` tracks rather than checks" — and a third of the board is tracking:

```
pass                 857   68.0%
improvement_target   403   32.0%
known_fail             1    0.1%
```

So the denominator is 857 rather than 1,261, and the per-country reading gets worse rather than better:

```
countries with at least one CHECKING row   99 of 130
countries with one checking row or none    78 of 130
```

Per shipping locale, with the checking half beside the total:

| Country | Board rows | Of those, checking | Case files |
| ------- | ---------: | -----------------: | ---------: |
| GB      |        152 |                106 |          9 |
| US      |        105 |                 82 |         10 |
| FR      |         67 |                 55 |          8 |
| ES      |         26 |                 12 |          3 |
| AU      |         25 |                 25 |          5 |
| **CN**  |         23 |              **2** |          3 |
| DE      |         16 |                  8 |          5 |
| NZ      |         14 |                 13 |          4 |
| IT      |         13 |                  6 |          4 |
| JP      |         11 |                  6 |          4 |
| **IN**  |      **3** |              **2** |          1 |

China ships a locale and is checked by two rows. India by two. Japan by six.

Three of the largest blocks are not shipping locales at all: a `GENERALIZATION` country sweep (279 rows), Singapore
(243, from the postcode work), and Canada (22).

**This is the finding the rest depend on.** A country with one or two checking rows cannot separate a real
regression from noise, so for 78 of 130 countries the board reports a number without the power to act on it. India
ships a weights package and is checked by two rows; China by two. The release list has moved past what the board
can measure, and a summary score over 1,261 rows reads as planet coverage while a third of those rows track
rather than check and 36% of the total sits in eleven countries.

Nothing here says the board is wrong. It says a per-country verdict is only available where the rows are, and the
places a planet geocoder is about to be judged — the other 119 countries — are not those places.

**The instrument for this already ships.** `mailwoman data coverage` reports `boardRows` and `boardPassedRows`
per country beside corpus rows, training admission, the weights package and gazetteer places, and its own
docstring states the reason this survey exists:

> It exists because the answer is held in five registers that do not agree, and reading any one of them alone
> produces a confident wrong answer. […] Training is not verification (a board row that is not `status: pass`
> tracks rather than checks).

What is new here is having read the board-rows column across all 130 countries at once and stated what the
distribution means. Reproduce it with that command rather than with a throwaway; the counts above come from the
committed case files, so they need no artifact, while the command's other four registers do.

## Two tables contradict a claim made elsewhere

### The D-rule's own list omits a tier-1 locale

`SCOPE.mdx` puts **US and FR** in tier 1. The only encoding of iron rule 6 in the tree is:

```ts
// packages/dev-mcp/lib/arc.ts:39
export const D_RULE_COUNTRIES = ["FR", "GB", "DE"] as const
```

`runArc` raises its blocking reason from exactly that list (`arc.ts:193`), so a candidate that regresses rows in
the United States produces no `D-RULE` reason, under a docstring reading "Locales that iron rule 6 — the D-rule —
guards unconditionally."

Read against the board table above, the list looks less like an oversight and more like _the countries where a
regression is detectable_ — GB 152, FR 67, DE 16 are three of the four best-covered. But US has 105 rows, second
only to GB, so that reading does not hold either. Either the list is wrong or the D-rule's scope grew past tier 1
without `SCOPE.mdx` recording it, and only the operator can say which.

Scope of the claim: `runArc` is a maintainer diagnostic rather than the release pipeline. The promotion battery and the
regression board may catch a US regression by other means; what is measured here is that the constant encoding
"unconditionally" does not name its primary locale.

### The cross-country plausibility guard is fail-open for four shipping locales

`COUNTRY_BBOX` (`packages/resolver/lib/plausibility.ts:107`) and its structured twin `MEASURED_COUNTRY_BBOXES`
(`gazetteer-pipeline/coverage-manifest.ts:118`) hold the same 18 boxes, asserted byte-identical to each other by
`coverage-manifest.test.ts`: US AU BR CZ DE ES FR GB HR IN NL NO PL PT RO SE SK SI.

Absent: **CN, IT, JP, NZ** — all four ship a locale. The constant's own docstring states what absence costs:

> A country absent here only never trips the guard (fail-open).

So guard B, "is this coordinate in the wrong country", cannot fire for Japan, China, Italy or New
Zealand. JP and CN published in the CJK arc at 9.3.0, after the boxes were measured on 2026-07-15.

This is adjacent to #2266, whose failures are all cross-country: `WA Sammamish` answering Wa in Ghana (11,279 km)
and `Fort Worth` answering Fořt in Czechia (8,666 km) are the shape a bbox guard exists to refuse. For a Japanese
or Chinese answer there is no box to check against.

Adding four boxes is a small data change and a real behaviour change. The guard would begin firing where it
never has — so it needs the board rather than a commit.

## Where the country tables' center of gravity still is

35 country sets across 29 files, found by taking every declaration whose NAME says so (`*_COUNTRIES`,
`*_BY_COUNTRY`, `COUNTRY_*`) **and** that holds at least three ISO 3166-1 alpha-2 literals. Both tests are needed:
the name alone admits `TIGERClassCode`, the literals alone admit every US state table, since `AL`, `CA` and `DE`
are each a state and a country.

Ranked by how several of the 35 name them:

```
DE 26   FR 25   US 24   GB 23   ES 20   IT 16   AU 14   CA 14   NL 14
NZ 11   IN 10   PL 10   JP  9   BR  9   BE  8   CZ  8   HR  8   NO  8
```

**CA (14) and NL (14) outrank JP (9) and match IN (10), and neither ships a locale.** The tables encode a
Europe-and-North-America center the release list has already moved past. That is not itself a defect — most of
these subsets are deliberate — but it is the shape to expect a twelfth locale to meet.

One class of absence is correctly handled and is recorded here so it is not re-reported: `HARD_PLACE_COUNTRY_SAFELIST`
and `MEASURED_COUNTRY_COVERAGE` omit CN, IN, JP and NZ, and their docstrings say absence means the soft prior with
no recall regression, with the measurement that kept FI (69.5%) and PL (77.8%) out cited in place. Absence there is
a measured state rather than a gap.

## Script cannot carry the CJK distinction, except for Korean

`classifyCodepoint` folds Hiragana, Katakana, Han, Hangul, Yi and the halfwidth forms into one `cjk` class, and
`scoreByScript` answers `ja-JP` at 0.8 for all of them. Counting ISO 15924 blocks over the per-country sets the
repository holds:

| Source                                            | CJK-containing rows | Kana decides Japanese | Hangul decides Korean |       Han-only |
| ------------------------------------------------- | ------------------: | --------------------: | --------------------: | -------------: |
| `data/eval/external/jp-overture-gold.jsonl`       |              11,946 |            356 — 3.0% |                     0 | 11,590 — 97.0% |
| `corpus-python/tests/.../kr-build-reference.json` |                  37 |                     0 |             37 — 100% |              0 |
| `gauntlet cases/cn/organizational-units.jsonl`    |                  59 |                     0 |                     0 |      59 — 100% |

Korean is categorical: the address vocabulary itself — 로, 길, 동, 시 — is Hangul, and every Korean row today is
labeled `ja-JP`. Japanese is not: 97% of those rows are Han-only because 県/市/区/郡/町 and most place names are
Han, so script does almost nothing for the Japanese/Chinese distinction.

The Japanese figure is a floor with a narrow denominator. That gold set carries postcode + prefecture +
municipality and nothing below it — median input 16 characters, p90 19, longest row `〒401-0300 山梨県南都留郡富士
河口湖町` — which is the most Han-heavy part of a Japanese address. A full address with a building name
(マンション, ハイツ, ビル) would carry Kana far more frequently, and this set cannot say how much more.

## What the gazetteer holds, per country

Answered after the fact through the `mailwoman-dev` MCP daemon, which runs in the operator's environment and. Therefore, has the data root a plain checkout does not. Places in `admin-global-priority.db`:

```
IN 1,113,550   CN 678,311   US 259,485   RU 159,485   PL 154,742
FR   114,751   ID 109,717   DE  87,279   BR  84,725   IT  72,436
MX    56,041   JP  54,488   KR  52,967   TR  46,979   GB  42,748
ES    41,173   PH  36,820   UA  31,720   PK  27,605   TH  24,998
NG    24,083   TW  18,597   AU  17,020   VN  16,584   CA  14,541
AR    10,595   BD   5,438   ZA   2,665   EG   2,439   NZ   2,373
SG        66
```

**India holds more places than any other country and is checked by two board rows.** That pairing states the
planet problem in one line: retrieval reaches a million Indian places, and nothing measures whether the answers
are right.

### One reading here was the instrument rather than the data

`mwdev_sources` reports **NL = 28** for this artifact, against 19,812 in the `-coverage` generation. Taken at face
value that reads as the promoted gazetteer losing the Netherlands. It has not:

| Path                                     |                    Amsterdam |                    Rotterdam | Utrecht |           Groningen |
| ---------------------------------------- | ---------------------------: | ---------------------------: | ------: | ------------------: |
| `admin-global-priority.db`, FTS + names  |                 143 row-hits |                           97 |     135 |                 143 |
| `candidate.db`, the resolver's own table | `wof:101751893`, pop 833,624 | `wof:101751843`, pop 629,606 |       — | three, by placetype |

The census counts `spr` rows; the resolver reads the FTS index. Only the first is low. What remains true and
narrow is that the `spr` count for NL moved 19,812 → 28 between generations while the FTS content stayed rich,
and nothing reachable from here says why or what still reads `spr`.

## What is still unanswered

Named so the next reader does not mistake silence for absence:

- **Whether any ranking change is safe.** Needs the regression board and the promotion battery. Every open item on
  #2266, plus #2267, #2268, #2269 and #2272, sits behind this.
- **The real Kana rate in full Japanese addresses.** Needs a JP corpus with building lines.
- **Whether the 119 thinly-covered countries are wrong.** A board row is the only instrument, and 78 of
  130 countries have one checking row or none.
- **Why the NL `spr` count fell**, and what consequence it has.

## Recommended order, given the above

1. **Board power before board verdicts.** A twelfth locale, or a claim about any of the 119, is unreadable until
   its country has more than two rows. This ranks above every mechanism fix, because it is what makes a mechanism
   fix checkable.
2. **The two contradictions**, each a decision rather than a patch: what `D_RULE_COUNTRIES` should be, and whether
   guard B should cover its four missing shipping locales.
3. **#2268's duplicate localities**, because it moves every downstream number and therefore wants to land before
   anything measured against those numbers.
4. **#2266 and #2267**, the resolver ranking defects, in whatever order the board's power allows.

Items 3 and 4 are already filed with diagnosis and receipts; nothing here supersedes them.
