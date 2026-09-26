# Mailwoman trajectory review and re-railing plan — 2026-07-01

**Date:** 2026-07-01 · **Scope:** project trajectory at v5.0.0 — where the last two months went versus where the plan said they would go, and a concrete plan to get the project back on rails. Produced from git-history analysis plus a doc/eval synthesis pass over `docs/articles/plan/`, `docs/articles/evals/`, `docs/articles/releases.mdx`, `evals/scores-by-version.json`, and the open issue queue. This review is about direction rather than code quality — the [2026-06-25 mile-marker review](./2026-06-25-claude-review.md) covers code quality and remains largely current.

---

## Verdict

The project's question moved from "does the model parse" to "does the system geocode", and that transition succeeded. The current risk is outside the code. The measurement system, the public demo, and the roadmap have all fallen behind what the pipeline can do, and the hardest remaining model problem is stalled behind a budget decision nobody has made.

Three facts frame everything below:

1. **The early model climb was real and has flattened.** Micro-F1 went from ~0.72 (v0.2.0) to 84.8 → 85.1 → 86.1 across v4.2 → v4.4, with starved tags rescued outright (street_suffix 48.8 → 96.6, po_box 0 → 89.1). Since v4.4.0 no full per-tag re-score has landed; the ledger rows for 4.2.0–4.4.0 carry `null` headline F1 and no newer row exists.
2. **The wins moved downstream of the model.** The largest recent gains came from resolver logic and data relabeling rather than weights: #822 lifted bare "City, Country" resolve from 54.2% → 77.9% with no retrain; the v4.13.0 multi-locale extract lifted EU resolve (IT 79 → 92.7%, PT 52 → 82%, AT 50 → 81.3%). This is healthy, and it is what the parse/resolve split was _for_. It also changed what "progress" means, and neither the measurement nor the roadmap was updated to match.
3. **Nobody outside the lab can see any of it.** The public demo runs its own `runCascade` that skips the shared joint-consistency resolver passes entirely (#861), and it has trailed the npm model by multiple versions before (#203). The +23.7pp resolve win is invisible at the exact URL the project points people to.

The process discipline that got the project here — pre-registered checks, falsified changes reverted rather than shipped (#305: measured −21pp, rolled back), documented check revisions, ~30 postmortems — is strong and should not change. What needs to change is where the effort points next.

---

## Where the trajectory went

The repo dates to 2019 (Pelias-parser lineage) and was near-dormant through early 2025: a few commits a month, none in most months. Then 534 commits in May 2026 and 993 in June — 1,547 commits in two months, effectively one operator plus autonomous night shifts. In that window the project went from a rules parser to a 35-workspace monorepo: neural parser, WOF resolver, formatter, record matcher, three drop-in API surfaces (Nominatim/Photon/libpostal), a browser runtime, and a coverage-tile pipeline.

Against the original plan, three drifts need to be stated explicitly:

**The phase plan was abandoned rather than completed.** `plan/README.mdx` says Phases 0–4 "shipped and superseded by the release train," and the live roadmap moved to a project board (epic #488). Meanwhile the phase directory accreted post-hoc phases (7, 8E, 8-fresh-slate — the v0.5.0 rebuild), and new architecture specs are still being written six weeks after "shipped" (`2026-06-29-joint-consistency-resolution.mdx`, edited today). The plan directory now describes a project that no longer exists in the shape it describes.

**Locale scope tripled past its own boundary.** The v1 scope was "US + France… Japanese is a deliberate Phase 6 stress test rather than v1." Shipped reality: a 16-locale model (v4.13.0), Japan live in the resolver, Sweden queued as locale 17 pending license approval (#202). The multi-locale campaign became the main effort. It worked, but no document ever re-declared the scope, so every remaining plan artifact understates what the project is now responsible for maintaining.

**Whole workstreams appeared that the plan never mentioned.** Record matching (Fellegi-Sunter scorer, NPPES dedup benchmarks, epics #602/#603/#615/#625/#655), the client-side WASM geocoder demo, competitive benchmarks against Nominatim/Pelias/Photon. Each is justified on its own, but together they form a second product growing inside the first one's roadmap.

This is not a criticism. Scope expansion driven by real wins is how solo projects find their product. But an expanded scope with a frozen plan means every new contributor (and every future autonomous shift) orients against a map that is wrong.

---

## Risks, ranked

**R1 — Metric substitution without a re-anchor.** The north-star moved from label-F1 to "grade the coordinate, never label-F1" (v4.15.0 promotion doc). The change is defensible because the coordinate is what users get. Since the switch, however, five label-F1 regressions shipped as "coordinate-invisible" (three in v4.13.0, two postcode floors lowered in v4.15.0, each with written justification). Each call was individually sound and documented. The pattern is the risk: the label metric can now erode indefinitely as long as each step is small, because no check forces a periodic full re-score. The ledger that would catch drift (`evals/scores-by-version.json`) stopped being populated at v4.4.0, and `AGENTS.md` still calls it authoritative.

**R2 — The hardest model problem is stalled with no probe.** Slavic/accented diacritic tokenization is the dominant open defect: CZ 84% and PL 77% content-gap rates root-caused to mis-tokenization (`Grudziądz` splits at `ą` and eats trailing digits; `Montréal, QC` drops the `C`; `ß` splits). No CPU-only fix exists. The fix is a rendering/retrain change (#825) that has been deferred twice, and the shift notes themselves concluded "only the RENDERING fixes it." Every locale past the original scope makes this defect more expensive to leave open, and there is currently no cheap probe defined that would inform the go/no-go.

**R3 — The demo lies about the product.** #861 (browser cascade skips the joint-consistency passes) means the marquee resolver wins do not execute in the browser at all. #203 showed the demo can silently trail npm by two model versions. The stated long-term goal is that the demo _becomes_ the geocoder; today it is the least accurate rendition of the system that exists anywhere.

**R4 — Operator-conditional decisions are accumulating.** #825 (GPU budget go/no-go), #875 (breaking `Us`/`Json` rename batch → next major), #861 (demo parity), #378 (blocked on Chrome hardware for in-browser P95), #379 (tar 7.x), the #493 serializer interface (#864), ODbL counsel sign-off (#260/B3), the Sweden license clock (#202). None is blocked on code, and several are weeks old. Each time an autonomous shift re-reads, re-defers, and re-documents one of them, it spends real shift time. The backlog itself has an ongoing cost.

**R5 — The record of record is stale.** `releases.mdx` said "4.11.0 (current)" while shifts referenced v4.15.0+; the last full parity scorecard is 2026-06-11; the two version series (npm 4.x/5.x vs training v0.x) still confuse, and the doc built to disambiguate them is itself out of date. Each gap is small, but together they mean no single document currently describes the project's state accurately.

**R6 — Focus discipline on breaking changes.** The v5.0.0 acronym sweep — a large, breaking, cosmetic rename — landed mid-campaign, produced 70 typecheck errors in diagnostic scripts, and immediately spawned a follow-on breaking batch (#875). The sweep itself is fine. The problem is that it landed during an active model campaign and shipped incomplete. Version-conditional batches should ship whole or wait.

---

## Game plan

The ordering principle: **make the truth visible first, then decide, then spend.** No item below requires new architecture. Tracks 1–3 are days of work; Track 4 is the only item that costs training budget, and it comes last on purpose, blocked by everything before it.

### Track 1 — Ship the truth to the demo (days, without a retrain)

This is the most valuable item in the backlog, because every win already shipped is discounted to zero until the demo serves it.

- **Fix #861:** route the browser cascade through the shared `resolveTree` joint-consistency passes (or extract those passes to a target both runtimes import). Acceptance: the #822 "City, Country" cases that resolve on the server resolve identically in the browser.
- **Close the version-lag class rather than the instance:** add a release-train checklist item (or CI check) that fails when the demo's pinned model/package version trails the latest npm release. #203 was fixed once as an instance; make it structural.
- While in there, spend the small effort on #827 (progressive region centering / gazetteer cold-load) only if it comes naturally out of the parity work. It is polish rather than a correctness fix.

### Track 2 — Re-anchor measurement (days, CPU only) — #885

R1 and R5 have the same fix: one full re-score and one documentation truth-pass.

- **Run a full per-tag parity re-score** against the current shipped model (v5.0.0 line) on the same golden sets as the v4.4.0 check, and publish it as `parity-scorecard-2026-07-xx.md`. This re-baselines the "coordinate-invisible" ledger of deferred label-F1 debt in one shot: either the erosion is bounded (likely) and the pattern is vindicated, or it is not and we learn that now, cheaply.
- **Decide the ledger's fate explicitly.** Either repopulate `evals/scores-by-version.json` from the re-score and commit to updating it at every promote, or formally deprecate it and update `AGENTS.md` to name the actual authority (the latest parity scorecard + per-release model-cards). The current state, documented as canonical but filled with nulls, is worse than either option.
- **Truth-pass the three stale records:** `releases.mdx` current-version line, `status.mdx` (still quoting v4.4.0 tables per the 06-25 review), and the plan `README.mdx` — see Track 5.
- **Add the standing rule:** every N promotes (suggest 5) or any promote that lowers a check floor triggers a full re-score. Write it into `CONTRIBUTING_MODEL_WORK.mdx` so it is enforced rather than left to good intentions.

### Track 3 — One decision session to drain the operator queue (hours)

A single sitting, decisions pre-framed so each is a yes/no/date rather than an investigation:

| Decision                  | Frame                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| #825 GPU retrain          | Go/no-go conditional on Track 4's probe result — decide the budget _ceiling_ now, spend later                    |
| #875 rename batch         | Assign to the next major's milestone, explicitly not before; close the discussion until then                     |
| #861 demo parity          | Approved via Track 1 (this plan)                                                                                 |
| #378 in-browser P95       | Either provision Chrome on the lab box (or any macOS/CI runner with Chrome) or formally park the SLO with a date |
| #260/B3 ODbL, #202 Sweden | External-blocked: set a check-back date each and stop re-reading them every shift                                |
| #379 tar 7.x              | Delegate to a night shift as a bounded chore                                                                     |

The main benefit goes beyond the decisions themselves: autonomous shifts stop spending time re-triaging the same items.

### Track 4 — The #825 campaign, probe-first (the funded one)

The diacritic defect (R2) is the only thing on the board that requires training budget, and the falsified-change discipline that served the project should apply to it before the spend:

- **Pre-register the check before anything runs** (per `CONTRIBUTING_MODEL_WORK.mdx`): CZ/PL content-gap rate targets, a no-regression floor on the US/FR subsets from Track 2's fresh scorecard, and the DE/`ß` and FR-accent cases (#727) as named subsets.
- **Define the cheap probe first:** before a full multi-locale retrain, a bounded experiment that isolates the rendering hypothesis — e.g., a tokenizer-only rebuild (or byte-fallback coverage audit) scored against the failing CZ/PL spans on CPU, to confirm the failure is representational before buying GPU time to fix it. If the probe can't be defined, the shift notes' own rule applies: not ready to train.
- **Freeze locale expansion until this lands.** No locale 17 (Sweden waits on its license anyway) and no new locale extracts before the rendering fix, because every added locale deepens the exact defect this campaign exists to fix.

### Track 5 — Re-declare the scope (one document, half a day) — #886

Write the successor to `plan/README.mdx` — a short "what mailwoman is now" scope doc that: names the real locale set and its tiers; admits record-matching as a second workstream with its own epics rather than a footnote; states the demo-is-the-geocoder goal and its parity requirement (Track 1) as a standing invariant; and marks the phase directory as historical. The 06-25 review found the internals excellent and the public entry points fictional. The same is true of the plan, which is the entry point for internal contributors. It should stop describing a US+FR parser.

### What not to do

- **No new resolver micro-changes past the frontier.** The shift notes already identified the residual as gazetteer name-key hygiene and exonym coverage (#877) rather than more changes — #781 measured +0.0pp and was correctly closed. Do not keep adding resolver changes that measure no gain.
- **No breaking cosmetic sweeps mid-campaign.** #875 waits for the major it is assigned to.
- **No new locales before the rendering fix** (covered above, worth repeating as a rule).
- **No new workstreams** until Tracks 1–3 are done. They total less than a week and everything else compounds on them.

---

## Sequencing

Tracks 1 and 2 are independent and can run in parallel (Track 1 is demo/runtime code; Track 2 is eval + docs). Track 3 needs an hour of operator time and can happen any day. Track 4 starts only after Track 2's re-score exists (its checks depend on the fresh baseline) and Track 3 sets its budget ceiling. Track 5 can be a night-shift deliverable once 1–3 have landed, so the new scope doc describes the re-railed state rather than promising it.

Success, four weeks out, looks like: the demo resolves what the server resolves; a 2026-07 parity scorecard exists and the ledger question is settled; the operator queue holds only externally-blocked items with check-back dates; and #825 has either a probe result and a funded check, or a documented no-go. At that point the project's effort would again match its stated direction.

---

## Addendum — 2026-07-02: #825 resolved overnight; Track 4 rewritten

Between this review and the next morning, the night shift answered the #825 question, and the answer made Track 4 as written unnecessary.

**What happened.** The extract retrain the plan was blocking (v196-slavic-anchor, correctly built on the v4.15.0 base) ran and was falsified: it held US but regressed CZ at convergence (wrong-city 44 → 58%, resolved-p50 5.24 → 82.89 km). Root-causing the failure found the bottleneck was never training data: the 48k SentencePiece unigram vocab contains the diacritic _characters_ but no multi-char _subwords_ containing them, so every diacritic isolates its own piece (`Vysoká → [▁V, ys, ok, á]`) — and a unigram model cannot emit a subword absent from its table, so no volume of data fixes it. The fix is a **training-free tokenizer vocab-splice + embedding mean-init** (#884): CZ wrong-city 44 → 28%, PL 30 → 11%, US coordinate output byte-for-byte identical by construction (bootstrap diff 0, CI [0, 0]). No GPU. The ship candidate is the mean-init model; a 2k fine-tune was ablated and retired as slightly harmful.

**What this confirms.** Two of the practices this review said to keep worked as intended in one night. The falsified-change rule stopped the retrain instead of shipping it, and coordinate-first grading caught a regression that label-F1 would have promoted — the retrain's content-gap label metric _improved_ 100 → 17 while the coordinate regressed. That is the sharpest evidence yet for the R1 nuance: the re-score in #885 is a drift _backstop_ rather than an argument for re-anchoring on label-F1.

**R2 is closed as written.** "Stalled with no probe" no longer describes the state. The probe ran, the hypothesis changed from data to representation, and the fix is committed and reproducible (branch `feat/825-v196-slavic-anchor`, `tokenizer_splice.py`, day eval `2026-07-01-day-825-tokenizer-fix.md`). The residual risk moves downstream: shipping it.

### Track 4, rewritten — ship #884 (without a campaign or GPU)

The remaining work is mechanical and tracked on #884:

- **#291 — grow the CZ/PL coord eval sets 150 → ~1k.** The 150-row sets are underpowered (CZ p50 CI was [−40, −0.34]); wrong-city% is the defensible headline until then. This is the #884 equivalent of the pre-registered check and should land before promotion.
- **#293 — int8-quantize the mean-init model and measure the browser budget.** The vocab growth (48k → 58.6k) took fp32 ONNX 118 → 134 MB; int8 lands near ~34 MB against the ~30 MB browser SLO. If it busts, the fallback decision is prune rarer diacritic pieces vs ship server-only — an operator call, added to Track 3.
- **#295 — the coordinated model + tokenizer promotion** (operator check). The spliced tokenizer ships _with_ the model in both runtimes; model-card plus OA CZ/PL ODbL/CC-BY attribution. This inherits Track 4's old role as the conditional spend — except the spend is now a release rather than a training run.
- **#296 — CZ/PL coverage residual** (re-opened): the remaining wrong-city is gazetteer/rooftop coverage, downstream of the now-fixed parse. OA CZ 2.83M + PL 7.67M rows already on disk.
- **#297 — CharCNN CJK track stays deferred.** It is the next representational question rather than this one.

### Consequent edits to the standing plan

- **Track 3 decision table:** the "#825 GPU budget ceiling" row is moot. Replace with two calls: the #295 promote go/no-go (after #291 + #293 land), and the #293 fallback (prune vs server-only) if int8 exceeds the browser SLO.
- **Locale freeze:** the rule "no new locales before the rendering fix lands" becomes "no new locales until #295 ships the coordinated bump" — the fix exists but is not shipped, and every pre-#295 locale extract would train against the old vocab.
- **Track 2 sequencing gains a hard edge:** run #885's full re-score on the _current shipped line_ before #295 promotes, so the splice lands with a clean pre/post baseline; the post-#295 scorecard then becomes the first entry of the new re-score cadence.
- **Grading hygiene carried forward from the handoff:** baseline grades go against the explicit `model-v193a3-step-80000-int8.onnx`, never the dev symlink, which drifts (#259).

Success at four weeks, restated: the demo resolves what the server resolves; the 2026-07 scorecard exists and the ledger question is settled; the operator queue holds only externally-blocked items; and the coordinated model + tokenizer bump has shipped — or the int8-budget fallback is documented. Track 4 went from the plan's most expensive unknown to its most concrete deliverable in one shift.
