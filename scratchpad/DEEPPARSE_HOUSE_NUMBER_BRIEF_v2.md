# Why does deepparse beat us on house_number? - investigation brief, iteration 2

Written 2026-07-16 for the agent picking up the deepparse / digit-ownership investigation.

This is the revised handoff after the first pass eliminated the cheap plumbing explanations. It
puts the remaining work first, then preserves the evidence trail so the next agent does not
rediscover dead hypotheses.

## Mission

Answer whether deepparse's `house_number` lead is model knowledge, schema/field-order prior, or a
data-distribution effect.

Return only:

- verdict
- commands run
- changed files, if any
- raw output paths
- one table comparing mailwoman and deepparse on the control set below

Do not promote any deepparse comparison numbers until they have been re-derived on current main.

## Open Work

Three tasks remain. Start here.

1. **Re-derive deepparse numbers on current main.**
   The inherited comparison predates `ffcb8e96`, which made evals feed the query-shape prior that
   production feeds. The mailwoman side in the old report was measured on a starved config.

2. **Run H1: deepparse bare-fragment probe.**
   Test whether deepparse still calls bare digit fragments `StreetNumber` without a street/context
   field around them. If it does, the lead is likely model knowledge. If it collapses, deepparse's
   schema or fixed output-field order may be doing much of the work.

3. **Re-count H3 on the full Modal corpus.**
   The local count used one synthetic shard only (`corpus/staging/fragment-v8`). It pointed strongly
   toward house_number, not postcode, but it is not the real training distribution.

## Stop Criteria

- If deepparse collapses on bare digit fragments, treat schema/field-order prior as the leading
  explanation and stop model-theory speculation until that is written up.
- If the full corpus still shows `P(house_number | bare digit) >> P(postcode | bare digit)`, the
  training-prior explanation is dead or at least incomplete.
- If the full corpus flips toward postcode in the relevant contexts, Track B becomes a data-mix
  problem before it becomes an architecture problem.
- If current-main deepparse no longer leads on house_number, stop and update the comparison report
  before doing any deeper hunt.

## Control Set for H1

Run both parsers on this minimal set and save raw outputs.

| class                            | inputs                                                                                           | expected question                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| house-number-like bare fragments | `39A`, `44B`, `121`, `9600`                                                                      | Does deepparse emit `StreetNumber` with no street context?               |
| valid postcode-like              | `1234AB`, `90210`, `75008`                                                                       | Does deepparse distinguish postal-code-only queries?                     |
| invalid postcode-like            | `1234SA`, `0123AB`                                                                               | Does either system encode validity rules?                                |
| route/date/name digits           | `Interstate 35`, `FM 3009`, `11 Novembre`, `10 Ave`                                              | Does digit attach to route/street/date, or become house_number/postcode? |
| contextful controls              | `Epleskogen 39A`, `Tindvegen nedre 44B`, `aleja Wojska Polskiego 178`, `9600 S Interstate 35 TX` | Does context change assignment?                                          |

Report each output as reconstructed `house_number`, `postcode`, `street`, and any deepparse field
that absorbed the digit.

## Current Measurement State

| claim                                                                                       | source                              | trust                     |
| ------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------- |
| deepparse `house_number` 91.9% vs mailwoman 80.1% on country-controlled parity intersection | `deepparse-cmp/REPORT.md`           | inherited, not re-derived |
| micro is 71.8% vs 71.8% once country rows are excluded                                      | same                                | inherited, not re-derived |
| 16 empty-`house_number` misses have the number tagged `postcode`                            | report, re-verified on current main | measured                  |
| `house_number` 117/146 = 80.1% on parity                                                    | re-measured                         | measured                  |
| `postcode` false positives 25/249 = 0.100 where gold has none                               | re-measured                         | measured                  |
| fr-fragment shard v310 changes this by -1 row                                               | re-measured                         | measured                  |

The inherited deepparse-side numbers are useful as a lead, not as a citable result.

## Mechanism Known So Far

The house_number deficit is not mostly street swallowing. Only 4/29 misses look like that. The
dominant observed mechanism is postcode over-emission:

```text
Epleskogen 39A               hn=39a   -> mailwoman postcode="39A"    deepparse StreetNumber=39a
Tindvegen nedre 44B          hn=44b   -> mailwoman postcode="44B"    deepparse StreetNumber=44b
Øvste Skogen 121             hn=121   -> mailwoman postcode="121"    deepparse StreetNumber=121
14 Glen Neaves               hn=14    -> mailwoman postcode="14"     deepparse StreetNumber=14
aleja Wojska Polskiego 178   hn=178   -> mailwoman postcode="178"    deepparse StreetNumber=178
22024 main st, ca            hn=22024 -> mailwoman postcode="22024"  deepparse StreetNumber=22024
```

Deepparse gets 15/16 of this class right in the inherited run. `39A` and `44B` are not Norwegian
postcodes; Norway uses four digits. This is not a subtle geocoding ambiguity. Mailwoman is assigning
a digit-bearing token to a structurally implausible tag.

## Why `1234SA` Is In The Control Set

The invalid-postcode row is not a hypothetical. The parity gold encodes the Dutch rule as
**deliberate minimal pairs**, and we fail three of the four:

```text
nld-18  "1234AB, Amsterdam"                    -> postcode: ["1234AB"]   AB valid            we PASS
nld-20  "1234SA, Amsterdam"                    -> NO postcode            SA excluded         we FAIL
nld-21  "Haarlemmerdijk 12, 1234SS, Amsterdam" -> NO postcode            SS excluded         we FAIL
nld-22  "Haarlemmerdijk 12, 0123AB, Amsterdam" -> NO postcode            range starts 1000   we FAIL
```

Dutch postcodes exclude the `SS` / `SD` / `SA` letter pairs (Schutzstaffel, Sicherheitsdienst,
Sturmabteilung) and start at 1000. Same shape, one letter apart, opposite expectations - that is test
design, not noise. The v1 rules era encoded the rule; the neural model does not have it.

Two things make this the sharpest single fact in the brief:

1. **The gate could not see it for the entire campaign.** Every parity floor did
   `if (!goldValues?.length) continue`, so a postcode emitted where the gold has none cost nothing.
   `postcode 98.6%` was recall. The tests were sitting in the corpus, passing silently, measuring
   nothing.
2. **`codex/` has no `nl` slice** and no postcode letter/range rules anywhere, so nothing in the
   system _can_ reject `1234SA` - or `39A`, where Norway uses four digits and no letters.

This is why the control set separates valid from invalid postcode-like fragments. If deepparse also
emits `1234SA` as a postal code, neither system encodes the rule and the minimal pairs are testing
something no one has built. If deepparse rejects it, find out what it knows.

## Two Tracks, Not One

Track A is **bare-street polarity / span segmentation**. The BAN fr-fragment shard appears to handle
that class: bare-street, particle, and homonym cells moved sharply, contextful guards improved, and
bare-locality held.

Track B is **digit ownership**. It is unstarted and untouched by Track A's fix. The shared question
is: what does this digit belong to?

- house_number vs postcode
- route number vs house_number
- date/name digit inside street vs house_number
- digit absorbed into street span vs split out

Do not let BAN augmentation become the whole next chapter. It fixed French bare-street polarity. It
does not explain `39A -> postcode`, `S Interstate 35 -> house_number`, or `11 Novembre` splitting.

## One Defect Seen from Four Instruments

Treat these as one digit-ownership problem until proven otherwise.

| instrument            | observation                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| span decode cross-tab | span decode pulls digits into street: `Korunní 810` -> street `korunní 8`; 8/17 regressions                        |
| FR fragment board     | BIO pushes digits out of street: `Allee du 11 Novembre` -> street `Allee du`, house_number `11`, street `Novembre` |
| deepparse comparison  | bare digit spans become postcodes: `39A` -> postcode                                                               |
| parity precision      | route numbers become house numbers: `S Interstate 35` -> hn `35`, `Wiederstein Rd At Fm 3009` -> hn `3009`         |

A hypothesis that explains only postcode over-emission is probably too narrow.

Note on the first row: the span decode was closed on 2026-07-16 — it lost to the plain BIO argmax of
its own model on identical weights and fixtures, so it is not a live option and there is no flag to
toggle. Its digit observation still counts as evidence: two different decoders over the same encoder
disagreed about which side of the boundary a digit falls on, which is what makes this a
representation problem rather than a decoding one. Do not spend time trying to reproduce it through a
decode option.

## Dead or Lower-Priority Hypotheses

### H2 - postcode anchor channel teaches the error

Current evidence points against this. On failing rows, the anchor often matches no span at all:

```text
Epleskogen 39A               no anchor span matched
Øvste Skogen 121             no anchor span matched
Tindvegen nedre 44B          no anchor span matched
14 Glen Neaves               no anchor span matched
aleja Wojska Polskiego 178   no anchor span matched
```

For Dutch postcode-shaped rows, the anchor reports `none` with `0.000`, including both valid and
invalid cases:

```text
1234AB, Amsterdam   1234AB   none   0.000   empty posterior   gold: postcode
1234SA, Amsterdam   1234SA   none   0.000   empty posterior   gold: not postcode
```

That was channel inspection. **A clean runtime ablation was ALSO run** — the weights package copied
with `postcode-us.bin` removed, so `loadFromWeights` cannot auto-resolve the lookup. The loader's own
warning confirms the channel was truly off, which is what makes it an ablation rather than a
claim:

```text
loadFromWeights: model-card declares the anchor channel REQUIRED but no postcode-<cc>.bin /
anchor-lookup.json found in the weights package - running anchor-OFF, parses degraded.

anchor ON (shipped)      spurious 25/249   hn->pc 16   hn ok 117/146
anchor UNSET             spurious 25/249   hn->pc 16   hn ok 116/146
delta                    +0                +0          -1
```

Caveat carried: anchor-off is a channel-starved, OOD config (#718), so a CHANGE would have been
ambiguous between causation and starvation. **No change is unambiguous.** H2 is dead on both tests —
do not re-run it.

### Anchor coverage gap

Real issue, probably not this mechanism.

The en-us weight package ships the US postcode anchor; fr-fr ships FR. Other country binaries may
exist in the data root but are not packaged into the en-us model. `matchType: "none"` therefore means
"not in this package's anchor data," not "not a postcode in the relevant country."

But the direction does not fit the house_number defect:

```text
US      : 12/80  = 0.150   anchor has data
non-US  : 13/169 = 0.077   anchor mostly absent
FR      :  0/39  = 0.000   no en-us FR anchor bin, zero spurious
```

The packaging/meaning-of-zero bug deserves its own issue. It is not the current answer unless new
data reverses this pattern.

### H3 - corpus prior favors postcode over house_number

Partial local count points the wrong way:

```text
P(house_number | bare digit) = 0.810
P(postcode     | bare digit) = 0.101
locality 0.048, unit 0.035, street 0.006
```

Limit: this was one local synthetic shard, not the full 700-shard Modal corpus. Re-run this before
relying on it. If the full corpus agrees, the model is contradicting the corpus prior and this
becomes more interesting.

### H5 - deterministic postcodeRepair regex adds the false positives

Measured dead:

```text
postcodeRepair ON  : 25/249 = 0.100
postcodeRepair OFF : 25/249 = 0.100
caused by regex    : 0
```

The regex pass is innocent here because the model already emits postcode; there is no missing span
for the repair pass to add. It is still a hard rules layer with overwrite authority, so do not expand
it as a fix without review.

## Still Open

### H1 - deepparse schema/field-order prior

This is the current front-runner by elimination and the cheapest unrun test.

Deepparse may benefit from a fixed output schema where `StreetNumber` is a field rather than a free
BIO tag. If it only succeeds when a street field is present, its house_number lead is partly schema
prior. If it succeeds on bare fragments, it has learned something mailwoman has not.

### H3 full-corpus count

The local count is too limited. Re-run against the real training corpus. Use the same bare digit-ish
definition (`\d+[A-Za-z]?`) first, then refine only if needed.

## Precision Gates

The parity gate now prints false-positive precision diagnostics:

```text
house_number   6/175 = 0.034   emitted where gold has none
postcode      25/249 = 0.100
street        12/54  = 0.222
```

Keep these permanently. Whether they become formal floors is an operator decision because they carry
tradeoffs: `house_number` false positives include highway/route numbers, which may require different
policy from postcode false positives.

## Reproduce

```bash
node scratchpad/postcode-precision.mjs
node mailwoman/out/cli.js eval parity --weights-cache scratchpad/v264-cache

# Re-derive deepparse side on current main before quoting it.
node scratchpad/deepparse-dump-mailwoman.run.ts
cd /home/lab/Projects/deepparse
source .venv/bin/activate
python /home/lab/Projects/mailwoman/scratchpad/deepparse-dump.py
cd /home/lab/Projects/mailwoman
python3 scratchpad/deepparse-score.py
```

## House Rules

- Never attack a competitor by name. Deepparse is good research, and the read is that it ties
  mailwoman where schemas overlap and beats it on one tag.
- Docs cite shipped models, not staged cards.
- Do not publish internal issue numbers, branch names, or scratchpad paths in outward-facing docs.
- If the proposed fix is "add a postcode validator," stop. The acceptable shape is a soft feature or
  evidence channel, not a hard veto.
