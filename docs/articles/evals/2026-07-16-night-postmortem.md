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
- **B4 / B5** — shards, only if the board says there is anything left to fix. No GPU without a
  falsifiable probe.
- **The retrain** — warranted (Norway goes 0% → 4.19%), but it needs B3 first so the read is
  pre-registered rather than reverse-engineered from whatever moves.

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
