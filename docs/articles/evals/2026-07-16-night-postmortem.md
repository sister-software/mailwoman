# Night shift — 2026-07-16 (Track B: digit ownership)

> Living document — sketched during the shift, finalized at hand-off (15:00 UTC). Window opened
> ~06:10 UTC.

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
- **`d9e76e75` + LAUNCHED — the v3.3.0-no-fragment probe.** The 2k falsifier for B4. init_from
  v310, ONE variable (synth-no-fragment @ 12.0), synth-no-street-led zeroed (contaminated part).
  Overlay verified through the real loader: Norway rows now survive the filter. Training clean —
  `init_from missing=0`, loss ~1.00, no NaN. Pre-registered read in the config header: bare-street-hn
  (0.693) must move or the licence-transfer hypothesis is wrong; bare-pc must hold 1.000. **Result
  pending — read against board 3 on completion. NOT a ship regardless of outcome.**
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

_(kept current so an interrupted shift hands off cleanly)_

- **B1 — DONE.** Norway was absent, mechanically. `#1145`.
- **B2 — mostly collapsed by B1**, and this is the important consequence. The street-familiarity lead
  was _confounded with country coverage_: `Epleskogen`/`Tindvegen` were unfamiliar because there were
  zero Norwegian rows, and `Main St` was familiar because the US is ~45% of the corpus. On the old
  corpus you could not separate those — every unfamiliar street WAS from an absent country. Three of
  the five cost-arm rows are Norwegian and one is NZ; all four are explained by coverage and must be
  **re-measured after a Norway-inclusive retrain**, not theorized about further.
  **One row survives:** `aleja Wojska Polskiego 178` — PL is in `country_weights`, passes the filter,
  the street parses correctly, and the digit still goes to postcode. That is genuine digit ownership
  with no coverage excuse. n=1, which is an anecdote until B3 gives it a CI.
- **B3 — now the critical path.** The Track B eval board. Negative class required (real-postcode
  rows), baselines registered against **shipped v310** before any candidate exists. Nothing can be
  graded until this exists.
- **B4** — the NO _fragment_ shard, blocker now cleared (`80d86130`). Board 3 says the EXISTING
  shard aims at ceiling, so B4 is a NEW recipe emitting the forms it never does: `{street} {number}`
  and bare `{street}` with no partner (bare-street-hn, 0.693), slash/cadastral fragments (slash-hn,
  0.650), plus a bare-locality + bare-postcode counter-distribution. Shard design is written into the
  task; **not launched** — needs the config header's pre-registered read and a 2k-step probe first.
- **B5** — the intra-word split licence (`12/345`), instance 3. Independent of B4.
- **The retrain** — warranted (Norway 0% → 4.19%) but only for a FRAGMENT shard, not the existing
  one. Pre-register against board 3 before launch.

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
