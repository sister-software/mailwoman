# Night shift — 2026-07-16 (Track B: digit ownership)

> Drafted live during the shift. Window: 06:12 UTC → ~08:25 UTC of active work (the shift runs to
> the 15:00 UTC hand-off; this documents the work done).

**Conn taken 06:12 UTC.** Prior day-shift work (the v6.4.0 promote, the span-head closure, the H3
verdict) is recorded on its own pages and in #1144 / #1141; this page covers the autonomous window
only.

---

## 1. What shipped

- **`dd14c671` — the YAML Norway problem. #1145, awaiting merge.** 44 configs have never trained on
  Norway. `country_weights: { NO: 1.0 }` parses to `{False: 1.0}` under YAML 1.1, so
  `country_weights.get("NO")` misses and the loader drops every Norwegian row. Live since
  v1.9.0-multilocale, through the shipped v264 (6.3.0) and v310 (6.4.0). **25,126 corpus rows
  reaching the model zero times — 12,000 of them from `synth-no-street-led`, a Norwegian shard at
  source weight 12.0, the maximum targeted-fix tier.** Someone built a shard to fix a Norwegian
  defect and it has never run. Fix proven end-to-end: `NO: 0` → `NO: 23,519` bare digit tokens
  (4.19% of the corpus). Two-part fix — quote the key in 44 configs, plus a `__post_init__` guard
  that rejects any non-string country key, because a config-only fix rots the moment someone adds a
  country. 124 tests.
- **`ed220724` — board 3: the NO digit-ownership board.** 2,400 Kartverket-derived fixtures, 6
  classes, Wilson CIs, baselines registered against shipped v310 — a **true zero-knowledge arm**,
  since v310 has never seen a Norwegian address. **Its first act was to veto the obvious next
  move.** `synth-no-street-led` emits three forms, all with postcode+city, and v310 already reads all
  three at **0.940–0.968** with zero Norwegian data. The 12,000-row shard the YAML bug has been
  dropping aims at classes _at ceiling_; un-dropping it and retraining would teach the model what it
  already knows. The headroom is elsewhere: `bare-street-hn` 0.693 and `slash-hn` 0.650 — forms the
  shard never emits. **A don't-launch verdict from a board, before any GPU.**
- **`d9e76e75` + `11881e69` — the v3.3.0-no-fragment 2k probe (B4).** init_from v310, ONE variable
  (synth-no-fragment @ 12.0), synth-no-street-led zeroed (contaminated part). Overlay verified through
  the real loader: Norway rows now survive the filter. Trained clean — `init_from missing=0`, no NaN.
  **RESULT: did NOT clear the pre-registered bar.** bare-street-hn 0.693 → 0.710 (+1.7pp, CIs overlap —
  not clear motion); bare-pc held 1.000; ceiling classes flat; and the FR guard drifted (board 2
  −1.7pp overall). Per my own pre-registration the 8k is not auto-warranted, and I did not relax the
  bar to launch it. Verdict: `docs/articles/evals/2026-07-16-b4-no-fragment-probe-verdict.md`. The
  named next move (B4b) is raising `--bare-street-prob` from 0.30.
- **`863a64ae` — the `no-fragment` recipe.** The shard itself (see §6/§7).
- **`80d86130` — `no-street-led` now requires `--exclude-surfaces`.** The B4 blocker. Board 3
  reserves 1,952 surfaces; this recipe trained on all 10,697 with no split, so a Norway retrain would
  grade memorization. Ports fr-fragment's discipline — with its OWN diacritic-keeping normalizer,
  because fr-fragment strips diacritics and would silently fold `Tømmerlien` → `tommerlien` and leak
  the surface. 5 tests, both directions of the hazard. Changes no shipped artifact.
- **`5ab73894` — the B0 verdict** (answers the operator's vindicate-or-villainize question). See §6.
- Nothing to production. **v6.4.0 is on main (`f31a519f`) but NOT published** — the npm/HF publish is
  a CI dispatch and an operator act. Untouched by this shift, by standing instruction.

## 2. What went well

- **B1 was the right first move and it cost one Modal run.** The night's plan put the cheapest
  measurement first — "is Norway absent or mis-taught?" — ahead of the shard it was meant to inform.
  It answered a question nobody had asked (absent, and for a _mechanical_ reason) and made B2, B4 and
  most of Track B either moot or unaskable-as-designed. A shard built on the pre-B1 theory would have
  been a fix for a defect that does not exist.
- **The absence-vs-zero discipline paid immediately.** The census block prints the per-country row
  count _before_ the conditional table specifically so a missing row reads "no data" rather than
  "probability zero" (`the-meaning-of-zero.mdx`). That framing is the only reason `NO: 0` read as
  _suspicious_ instead of _informative_ — a zero in the conditional table would have looked like a
  finding and closed the question.
- **Verifying by parsing rather than grepping.** The whole bug was that the config text looks
  correct. Every check — the fix sweep, the tests, the guard — goes through the YAML parser or the
  real loader. A grep-based fix would have "passed" against the broken file.
- **Board 3 paid for itself before a single GPU-second.** Finding the Norway bug made "fix it and
  retrain" feel obvious and urgent. The board — built _first_, per the standing rule — showed the
  shard aims at classes already at 0.94–0.968. Building the instrument before the fix converted a
  plausible day of A100 into a two-line table.
- **The completeness audit bounded the bug class.** After Norway, the obvious question is "what else
  is silently dropped?" A raw-corpus country census (2M rows) vs the config filter, cross-referenced
  against `SCOPE.mdx`, found the class is **bounded to Norway**: every other dropped country is
  accounted for — JP (143k rows; tier 5, resolver-only, no parser claim), CN/TW (CJK, out of Latin
  scope), KR (SCOPE: "no adopted open path"), HU/IE/GB (queued, #733 OSM share-alike gate). **NZ is
  the one exception** — 8,967 corpus rows + tier-A LINZ data, in no tier and no queue. The audit
  found no second Norway; that is the finding.
- **The one row coverage couldn't explain turned into the finding that unified the track.** After B1
  reduced most of Track B to the Norway coverage bug, a single PL row survived (`aleja Wojska
Polskiego 178`). Tracing its piece-level posterior showed B0's exact signature on a
  correctly-parsed, in-corpus Polish street — B-house_number on the first digit piece, I-postcode on
  the continuations, length-conditioned (2-digit correct, 3-digit fails). H3 + B0 + this are one
  mechanism: the model faithfully reproducing a corpus prior that says long digit-run continuations
  are postcode. It also explains why B4 barely moved — a shard fights that prior uphill.
  `docs/articles/evals/2026-07-16-digit-incoherence-is-cross-lingual.md`.
- **The 2k probe did its job — it stopped an 8k run I would otherwise have wanted.** The instrument
  and shard were correct; the read was clean; the target missed its pre-registered bar and the French
  guard drifted, so the expensive run does not happen on a hunch. ~$1-2 of A100 to avoid ~$8. And I
  held my own bar rather than relaxing it once the number disappointed — the discipline cuts both
  ways or it is not discipline.
- **`bare-street-hn` was designed as a diagnostic, not a score, and that is why it resolved the
  track.** It carries no postcode, so nothing competes for the digit. It still fails 31%, and
  `Hallingrudveien 32` → locality+postcode while `Hallingrudveien 32, 3370 Vikersund` parses
  perfectly. Same street, same digit. That single pair moved Track B from "digit ownership" to "the
  licence, in Norwegian" — a class we have already fixed once, in French, for +50pp.

## 3. What could've gone better

- **Carried in from the day shift, and worth naming here because it set the night's method:** three
  of my own hypotheses died this cycle, two of them to a control I should have run first. The unit
  error (counting corpus tokens to explain a model that reads SentencePiece pieces) produced a table
  that looked authoritative and answered a question nobody asked. It is now memory
  (`feedback-count-at-the-unit-the-model-reads`) and the standing rule for the night: **count at the
  unit the model reads, via the real loader, and split the population before concluding.**

## 4. Decisions made autonomously

| decision                                                                | alternatives                                     | why                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fix all 44 configs, not just the live one                               | fix `v3.1.0` only; or fix none and file an issue | The dead configs are the historical record of what each run trained on. Leaving them lying is how the next salvage-a-config reintroduces it. The sweep is mechanical and parser-verified.                                           |
| Guard **raises** rather than coerces `False` → `"NO"`                   | silently repair the key                          | A config saying `false` does not _mean_ Norway — it means YAML changed the author's meaning. Coercing hides the identical bug in the next field that grows a bare-token key.                                                        |
| Did **not** add NZ (8,967 rows, absent from `country_weights` entirely) | add it while I'm in there                        | Not a type bug — a scope decision about which countries the product serves. That is the operator's call, and bundling it would smuggle a scope change into a bug fix.                                                               |
| Did **not** retrain on the now-Norway-inclusive corpus                  | launch a run overnight                           | The night-shift rule: >30min GPU with no falsifiable probe is a guess. The retrain is warranted but the _read_ has to be pre-registered against a board that does not exist yet (B3). Order: B3 → register baselines → then launch. |

## 5. Open questions for the operator

1. **The v6.4.0 publish.** Metadata is on main; npm + HF are untouched. Dispatch is yours.
2. **G-NAF EULA (blocks B5 if it ships).** `.notes/data-sources.md` records G-NAF as CC-BY with a
   **no-mail-compilation clause**. Training a parser is not compiling a mailing list, but G-NAF-derived
   weights are a licensing call, not a 3am one. B5's shard design names G-NAF as the tier-A source for
   the AU `12/345` split because it carries `flat_number`/`number_first` as separate columns — i.e. the
   gold split, for free. NZ LINZ is the fallback (attribution + registration).
3. **#1141's ordering flag** — the span head was built and closed _before_ the vocab work the research
   named as upstream. The closure was pre-registered and stands; whether the ordering is worth
   revisiting is yours. B0 weakens the case for re-opening it (see §6).
4. **B4b's ratio bump** — the probe verdict names `--bare-street-prob 0.30 → ~0.65` as the likely fix
   for the target barely moving. It's one knob and a 2k probe, but it's a knob-spin, so it wants your
   nod or a fresh-shift pre-registration rather than a 3am solo run.
5. **Merge `#1145`** — the whole Track B PR. The Norway fix (`dd14c671`) is independently
   cherry-pickable if you want it in main faster than the investigation commits.
6. **NZ is undeclared.** The completeness audit found 8,967 New Zealand corpus rows, a tier-A LINZ
   source (`.notes/data-sources.md`), and NZ in **no `SCOPE.mdx` tier and no blocked/queued list**.
   It is neither trained nor explicitly scoped-out — the one country-filter gap the audit could not
   account for. Decide: add it to a tier (it's Latin-script, English, tier-2 caliber with open data),
   or list it as blocked/queued like GB/IE. Not a code change tonight — a scope declaration.

## 6. The finding this shift is built on

B0 (day shift, `5ab73894`) answered the architecture question and **reframed the whole track**:

**One defect, three components.** The model will not read a component without its co-occurring
partner — it learned the joint distribution and not the marginals:

| #   | licence                                                | consequence                   | status                        |
| --- | ------------------------------------------------------ | ----------------------------- | ----------------------------- |
| 1   | a **digit** licenses the _street_ reading              | `Rue Montmartre` → locality   | **fixed** — v310 shard, +50pp |
| 2   | a **known street** licenses the _house_number_ reading | `Øvste Skogen 121` → postcode | open (B2)                     |
| 3   | a **designator** licenses the _intra-word split_       | `12/345` → one span           | open (B5)                     |

That is a **training-data property, not an architecture property**, and instance 1 was fixed with a
phenomenon shard plus a counter-distribution without touching the architecture. It is why the night's
plan is measure → shard, not measure → rearchitect.

Per-piece tagging is vindicated on a representational argument, not a score: `Unit 12/345 Main St` →
`unit 12` + `house_number 345` is **not in a word-unit tagger's output space at any confidence**. The
cost (intra-word incoherence) is real but confined to a tail — 2-digit continuations read postcode at
0.0270 on the 351/376 rows we get right, against a corpus conditional of 0.0427.

## 7. Concrete next steps

The night's investigable surface is exhausted; what remains is one operator decision and two
pre-registered probes for a future shift.

- **B4b (the live thread)** — raise `no-fragment --bare-street-prob` from 0.30 and re-probe. The 2k
  probe moved the target only +1.7pp because 70% of its signal is `{street} {number}`, a form v310
  already reads at 0.693; B0's mechanism says the real defect is street→locality, which needs the
  street _without_ a number. One knob. Pre-register the read, run the 2k probe, read board 3. Also
  deconfound the FR board drift (v310 vs v330 board 2 in one session) before trusting it. Artifacts
  are all staged — only the ratio changes. **Not a 3am solo iteration** (treadmill guard): operator
  nod or a fresh-shift pre-registration.
- **B5 — data-blocked, an operator decision.** The `12/345` intra-word split (instance 3, confirmed
  by B0) needs the unit/number decomposition, which the on-disk assembled AU data does not carry
  (it's flattened to `house_number`). Re-deriving from raw G-NAF (which has the columns) is gated on
  the G-NAF EULA — a licensing call, not mine. NZ LINZ is the license-clean fallback.
- **The Norway retrain** — warranted (Norway 0% → 4.19%) but B4 showed the _existing_ shard aims at
  ceiling and a fragment shard at 0.30 barely moves the target. So the retrain is really B4b: a
  higher-ratio fragment shard, pre-registered against board 3, operator-approved.
- **B2 — closed, folded into B4b.** The street-familiarity lead was confounded with the Norway
  coverage gap (every unfamiliar failing street was from an absent country). The one PL row that
  survives coverage (`aleja Wojska Polskiego 178`) is now a board-3-measurable cell, not a separate
  investigation.

## 8. Where things stand (a status, not a wind-down)

Track B is a complete, self-consistent arc: the defect was mis-scoped as "digit ownership," B0
reframed it as one licence defect in three components, B1 found that most of the Norwegian evidence
was a YAML bug hiding 25k rows, B3 built the instrument, B4 built + probed the fix and the probe
honestly said "not with this ratio." Nothing is half-built; every commit is green-or-pending on one
PR. The next move is the operator's (merge `#1145`, decide the v6.4.0 publish, approve B4b's ratio
bump or the G-NAF path).

## Numbers

|                     |                      |
| ------------------- | -------------------- |
| window              | 06:12 UTC → _(open)_ |
| models trained      | 0                    |
| Modal spend         | _(running)_          |
| NaN incidents       | 0                    |
| CI failures         | 0                    |
| regressions shipped | 0                    |
| GPU lost to error   | 0                    |
