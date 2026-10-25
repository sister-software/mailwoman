# The lake investigation: what the model was fed, what changed its reading, and what the corpus held

Written 2026-10-23 from the investigation brief `scratchpad/2026/10/22/investigation-questions.md`, the handoff
`scratchpad/2026/10/22/HANDOFF.md`, the analysis report `scratchpad/2026/10/23/introspection/REPORT.md`, and the
follow-up measurements recorded on #2799. Every number here was measured on this host unless it is marked likely or
unknown. The case study is `Little Britain Lake, Uxbridge`, board row `gb-vob-little-britain-lake`, authored
2026-10-10 with expected components `venue Little Britain Lake, locality Uxbridge` and a coordinate at 500 m
tolerance.

The two models compared are model v7.10.0 seed 42, shipped in npm package 10.7.0 and staged at
`/mnt/mw/candidates/v800-control-shipped`, and the v8.2.0 candidate seed 42, staged at `/mnt/mw/candidates/v820-base`.
Both run under the current runtime with staged data files, as every comparison in the handoff did.

## The question

Can we explain which evidence was available, test which evidence changed the interpretation, and identify which
training experiences supported or failed to support that behavior, without claiming a reasoning history the model
does not expose? The answer is yes on all three parts, and each part has a tool now. The trace records what was fed.
A channel pin tests what changed the reading. The support index counts what the corpus held.

## The twelve starting questions

| Question                                                     | State                                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. How does a decoder cope with an input of this shape?      | Answered. The Viterbi pass chooses among labelings the encoder scored. Both models scored `B-venue` below zero at the first token, so the venue reading was never a candidate. |
| 2. Is the corpus sufficient in its variety of lakes?         | Measured. 53 distinct GB water-word venue texts in v0.7.10 train, `Lake` closing 5 GB venue rows, 0 GB `venue\|locality` rows in either corpus.                                |
| 3. Do the masks teach the deceptive-but-different contrast?  | Measured in part. GB `locality\|region` 310,890 rows against `street\|locality` 22,253 and `venue\|locality` 0. The contrast matrix is open.                                   |
| 4. How would we make holdout rows for this?                  | Open. The support index gives the before-and-after audit, and the five NZ and PT values v0.8.2 lost are the first case read.                                                   |
| 5. How do we measure that the decoder activates as expected? | Answered through the trace's five channels, lexicon digests, path margins and the `channels` pin. Hidden-state probes are open.                                                |
| 6. What looks the same to the model?                         | Measured on the board (locality read as street 40 rows, region read as locality 28) and per row through `mwdev_fanout`'s flip set. Model-discovered groups are open.           |
| 7. What should surprise and predictability mean?             | Answered. Label uncertainty, the path margin and channel sensitivity are computable. `forward_mlm` was never trained, so input-text likelihood is unavailable.                 |
| 8. to 11. Decoder, encoder, auto-encoder, auto-decoder       | Defined below. The deployed model is an encoder tagger with a structured-prediction decoder.                                                                                   |
| 12. Why ask these questions?                                 | To have the agent name the object before explaining it, count rather than narrate, and state what the model cannot expose.                                                     |

## The model under investigation

The deployed parser is `MailwomanCoarseEncoder`: a 6-layer encoder with hidden size 384 over a 73,143-piece
SentencePiece vocabulary, a 33-label BIO head, and a Viterbi pass over emissions that are the head's logits plus
priors (the FST prior over Who's On First admin names, the venue-head prior, the street-morphology prior, the
placetype-pair prior and the conventions mask). There is no autoregressive decoder and no output over the text
vocabulary. The `forward_mlm` path is defined and was never trained or exported.

Five soft channels enter before the first block: anchor (postcode), gazetteer (a 333-entry cue lexicon), country,
street type (483 entries) and locality surface (392,653 entries). The trainer paints the locality-surface channel on
every row. The runtime builds it only after a street-type match and only in fragmented input mode.

In plain words, a decoder-only language model predicts the next token. An encoder maps tokens to contextual vectors
and classifies each position. The deployed model is an encoder of that kind. An auto-encoder reconstructs its input through a constraint, and
the untrained `forward_mlm` would have been the masked-token variant. An auto-decoder learns a decoder with a latent
code per example and has no counterpart in this repository.

## The case study, stage by stage

| Stage          | v7.10.0 (shipped)                                              | v8.2.0 (candidate)                              |
| -------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| Pieces         | `▁Little`, `▁Britain`, `▁Lake`, `,`, `▁U`, `x`, `bridge`       | identical                                       |
| Channels fed   | gazetteer, country, street type (`Lake`), locality surface     | identical                                       |
| Priors         | identical matrices                                             | identical                                       |
| Encoder logits | `B-venue` −0.36 at token 0                                     | `B-venue` −1.02 at token 0                      |
| Decode         | `street Little Britain, street_suffix Lake, locality Uxbridge` | `locality Little Britain Lake, region Uxbridge` |
| Resolver       | locality `Uxbridge`, 5 candidates worldwide, none GB           | region `Uxbridge`, 0 candidates                 |
| Coordinate     | 5,296 km off                                                   | 8,662 km off                                    |
| Grade          | fails coordinate and venue                                     | fails coordinate, venue and locality            |

The first divergence is in the encoder logits. Tokens, channels and priors are identical for both models. Both fail
the row, and the handoff's "regression" was a different wrong answer.

## What changed the interpretation

Eighteen lexicon-ablation arms (a copied weights root with one lexicon JSON edited, traced under `weights_cache`)
gave the eight-state table over the channels. The candidate flips to the shipped reading when `locality_surface` is
fed zeros. The shipped model holds its reading under all eight states. Over 190 GB board rows, pinning
`locality_surface` off moves 1 row per model. Lane 1 (#2793) turned the eighteen copies into one `channels` pin on
every tool, and the trace now records every fed channel, each lexicon's md5, the input mode and the per-token path
margin.

The minimal-pair ladder adds one fact. `Little Britain Lake, Uxbridge, UB9 6` reads `venue Little Britain Lake` under
the shipped model once the GB postcode is present, while the same input without the postcode reads
`street Little Britain, street_suffix Lake`. The anchor channel reaches the venue label that the bare row cannot.

## What the corpus held

Counted over every train row of each corpus, by the support index (#2798) and the earlier stride-1 scan:

| Count                                    | v0.7.10-gb-county (703,186,376 train rows) | v0.8.2 (668,151,871) |
| ---------------------------------------- | -----------------------------------------: | -------------------: |
| GB rows with tag set `locality\|venue`   |                                          0 |                    0 |
| GB rows with tag set `locality\|region`  |                                    310,890 |              314,321 |
| GB rows with tag set `locality\|street`  |                                     22,253 |           unmeasured |
| `Uxbridge` as a GB locality surface      |                                         76 |                   76 |
| `Uxbridge` as a GB region surface        |                                          0 |                    0 |
| `Lake` closing a GB venue                |                                          5 |                    5 |
| `Lake` as a GB locality surface          |                                        598 |                  598 |
| `Lake` as a street suffix, all countries |   25,789, all US `spliced-suffix-boundary` |           unmeasured |
| GB `street_suffix` rows                  |                                          0 |                    0 |

For this family the exposure hypothesis has no corpus difference to rest on. Neither corpus held the shape, and the
reading moved with the channel and the run.

## The resolver band miss

GB `Uxbridge` is a Who's On First `neighbourhood` row (85791255, population 70,560), and the locality band is
`locality, borough, localadmin`. 10,545 of 12,010 GB primary `neighbourhood` names exist in the candidate table under
that placetype only, so the row's coordinate assertion is unreachable through its locality under every parse. The
trace printed `reachableIn` for that lookup from the day the row was authored. Lane 2 (#2795) made it a shape:
`band_miss` when an empty lookup's key lives in another band, `expectation_unreachable` when a row's expected
component cannot be reached under its tag's band. Over the 190 GB board rows under the shipped engine, 14 rows are
unreachable and 19 lookups are band misses. #2800 holds the decision on how the gauntlet grades such a row.

## Run-to-run variation

Six runs from the v0.8 corpora read the row three ways: p000 admin, p005 mixed, p015 street, v8.1.0 seeds 42 and 43
street, v8.2.0 admin. Lane 3 (#2797) made this one call. `mwdev_fanout` runs an input set through up to eight arms and
reports a stability kind per row. Both lake rows are `stable_fail decodes 2` across the shipped weights and
`v820-base`: the arms disagree on the decode and agree on the loss.

## The follow-up measurements

All measured 2026-10-23 on the shipped weights under `en-US` with production pins unless stated.

**Venue-head prior.** On `St. Paul the Apostle Church`, `St. Paul Baptist Church` and `St. Bartholomew's Church`
the prior fires and the names are labeled `venue` with per-token path margins between 4.1 and 7.3. `Church of
Sweden` is `venue` with margins 4.5 to 4.7 without the prior, because `church` is a last-word head only. Two street
spellings expose boundary defects. `123 Saint Paul Place, NY` reads `Place` as `country` (margin −0.02), and
`123 St. Paul St., NY` reads the trailing `St.` as `locality` (margin −0.56). The `St.` and `St` spellings of the
first read `Place` as `street_suffix`.

**Venue-head list.** GB holds 1,810 first-word, 1,334 last-word and 147 suffix heads, and the English aggregate 636
and 818. Of the water words only `reservoir` is present. `lake` is excluded by the table's own rule, the log of the
venue rate over the higher of the place and street rates with positive entries only: GB train holds `lake` as a
locality 598 times and as a venue's last word 5 times. Of the 53 GB water-word venue texts, 37 end in a listed head.

**Tokenizer.** Twelve inputs tokenize at 0.428 pieces per character against 0.407 for three plain US addresses, with
0 byte fallbacks. `St` and `.` are separate pieces, `Paul's` is `Paul`, `'`, `s`, and `Saint`, `Lake`, `Place`,
`Church` and `Park` are single pieces. Proper names shatter (`Apostle` into 3 pieces, `Bartholomew` into 4, `Uxbridge`
into 3). No vocabulary change is indicated by this panel.

**POI presence.** `poi.db` exact key holds 42 of 96 GB board venue values and 9 of 17 US. Of the 24 GB board rows
that fail on their venue, 10 have their venue in `poi.db` and 14 do not, among them `Little Britain Lake`,
`The O2` and `Heathrow Airport`. Decision: no venue-name FST and no hand-extended head list under this arc. The
discriminating test for a later FST is on #2799.

**Holdouts.** The declared NZ holdout lists `christchurch`, `dunedin` and `wellington`. v0.8.2 train holds those
localities 0 times, and the four NZ board values fell with them. PT has no declared holdout. `Lagos` fell from 2,603 to 48
locality rows and postcode `8600-315` from 158 to 0, so the hashed sub-region holdout took most of Lagos, likely.

**GB dependent locality.** No country in v0.7.10 train holds the tag set `dependent_locality|locality`. GB's
dependent-locality rows come from `wof-admin` (`dependent_locality|region` 149,169, bare 97,969), and the recipes
that write the tag write it inside a full address. The 13 GB, 4 DE, 3 FR and 3 BR board rows on that shape assert a
two-piece input no renderer produces.

**Absent values.** Of the 130 board rows expecting a closed-class value their country holds under no tag, 16 are in
countries with 0 corpus rows and 114 in covered countries. By tag: locality 56, dependent_locality 30, postcode 24,
country 12, po_box 11. The `po_box` entries are an index artifact, since a PO Box surface includes its number.

**Diagnose routing.** `execution_path: "board-routed"` runs each row under its country's overlay locale and scope.
The 11 `gb_venue_bare` rows under `en-GB` read `retrieval_empty` 5 (3 unrouted), `band_miss` 2 (1) and `rank_flip` 0
(2). The lake row's GB-scoped lookup finds no GB locality `Uxbridge`, where the unscoped path had ranked a locality
5,296 km away.

**The CN and EC clusters across seven arms.** The shipped weights and the six staged runs (p000, p005, p015,
v8.1.0 seeds 42 and 43, v8.2.0) were fanned over the 28 CN and 15 EC board rows on the single-config `en-US` path.
CN: the shipped arm passes 18 of 28, and every v0.8 arm passes 3 or 4 of 28, with 16 rows flipping and 9 stable
fails. The comparison is confounded for CN: the staged roots hold no `@mailwoman/neural-weights-cjk` package, so their
CJK inputs ran on the en-US model while the shipped arm ran the installed CJK family. The worker log records the
substitution once per staged arm. The corpus
side is identical in v0.7.10, v0.8.1 (668,068,658 train rows) and v0.8.2: 23 of the 26 CN rows with expected components sit on a tag set CN train never holds
(`dependent_locality|locality_unit|region` and the like), and 11 expect a farm-unit value such as `十五分场场部` that
CN train holds under no tag, and `HEILONGJIANG` is a CN region 187,627 times in v0.7.10 and 183,759 times in both
v0.8 corpora. EC: the shipped arm passes 14 of 15, p005 13, v8.1.0 seeds 42 and 43 12 each, p015 11,
and p000 and v8.2.0 9 each, with 11 of 15 rows flipping, 4 stable passes, 0 stable fails and every row decoded at
least two ways. All 15 EC rows expect a bare `locality` and EC train holds 0 single-locality rows in each of the three corpora, with `QUITO` as a locality 132 times in each. The
EC cluster is run-to-run variation over an unsupported shape, and the v8.2.0 arm is the weakest of the six by three
rows.

**The lone towns and the directional suffix.** `Bloor Street West`: the shipped arm and p015 keep the whole street,
and the other five arms split `West` off as a locality. CA train holds `West` as a street's first word 2,955 times
and as its last word 1,502, and 0 bare `street` rows. `King's Lynn, Norfolk`: the shipped arm and seed 43 read
`locality` and `region`, p000 and p015 drop the region, and p005, seed 42 and v8.2.0 read the town as a street, while
GB train holds `King's Lynn` as a locality 5,313 times and `Norfolk` as a region 23,835 times inside 310,890
`locality|region` rows. `Conwy, Wales`: only the shipped arm reads town and region, and six arms read `Conwy` as a
street. `Newport, Wales`: the shipped arm and v8.2.0 read town and region, p000 and seed 43 drop the region, and p005, p015
and seed 42 read the town as a street. The inputs and the corpus support are the same for every arm. The first
diverging stage for these rows is the encoder's labeling, likely, as the lake row's trace showed for its two arms, and
a per-arm trace of the three GB inputs is the test that would confirm it.

## The fan-out defect this arc fixed

The first seven-arm run reported 57 errored readings (`database is not open` 47, `statement has been finalized` 10)
on the five arms acquired first (5, 13, 13, 13 and 13 readings) and 0 on the two acquired last. The same rows read
with 0 errors under two or three arms, and under seven arms with eight engines resident. The engine registry keeps two
engines resident and disposes the rest, and the fan-out had acquired every arm's engine before any row ran, so the
sessions of the first five arms were disposed before their passes. Each session arm now acquires its engine as its
pass begins, and the seven-arm run with two resident engines reads 0 errors in 51 s.

## Open

- #2800: how the gauntlet grades a coordinate assertion that is unreachable by data.
- The GB `dependent_locality|locality` shape, the CN farm-unit shapes and the 114 covered-country absent values, for a
  corpus lane.
- The CJK weights family in the staged roots, so a CN comparison across arms reads the same model family on every arm.
- Hidden-state probes, model-discovered confusion groups and the contrast matrix, from the brief's sections 4, 8 and 9.
