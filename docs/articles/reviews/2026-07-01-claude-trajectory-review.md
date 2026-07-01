# Mailwoman trajectory review and re-railing plan — 2026-07-01

**Date:** 2026-07-01 · **Scope:** project trajectory at v5.0.0 — where the last two months actually went versus where the plan said they would go, and a concrete plan to get the project back on rails. Produced from git-history analysis plus a doc/eval synthesis pass over `docs/articles/plan/`, `docs/articles/evals/`, `docs/articles/releases.mdx`, `evals/scores-by-version.json`, and the open issue queue. This review is about direction, not code quality — the [2026-06-25 mile-marker review](./2026-06-25-claude-review.md) covers code quality and remains largely current.

---

## Verdict

The project matured from "does the model parse" into "does the system geocode" — and that transition succeeded. The risk now is not the code; it is that the measurement system, the public demo, and the roadmap have all fallen behind what the pipeline can actually do, while the hardest remaining model problem sits stalled behind an unmade budget decision.

Three facts frame everything below:

1. **The early model climb was real and has flattened.** Micro-F1 went from ~0.72 (v0.2.0) to 84.8 → 85.1 → 86.1 across v4.2 → v4.4, with starved tags rescued outright (street_suffix 48.8 → 96.6, po_box 0 → 89.1). Since v4.4.0 no full per-tag re-score has landed; the ledger rows for 4.2.0–4.4.0 carry `null` headline F1 and nothing newer exists.
2. **The wins moved downstream of the model.** The largest recent gains came from resolver logic and data relabeling, not weights: #822 lifted bare "City, Country" resolve from 54.2% → 77.9% with no retrain; the v4.13.0 multi-locale shard lifted EU resolve (IT 79 → 92.7%, PT 52 → 82%, AT 50 → 81.3%). This is healthy — it is what the parse/resolve split was _for_ — but it changed what "progress" means without the measurement or the roadmap being updated to match.
3. **Nobody outside the lab can see any of it.** The public demo runs its own `runCascade` that skips the shared joint-consistency resolver passes entirely (#861), and it has trailed the npm model by multiple versions before (#203). The +23.7pp resolve win is invisible at the exact URL the project points people to.

The process discipline that got the project here — pre-registered gates, falsified levers reverted rather than shipped (#305: measured −21pp, rolled back), documented gate revisions, ~30 postmortems — is strong and should not change. What needs to change is where the effort points next.

---

## Where the trajectory actually went

The repo dates to 2019 (Pelias-parser lineage) and was near-dormant through early 2025: a few commits a month, none in most months. Then 534 commits in May 2026 and 993 in June — 1,547 commits in two months, effectively one operator plus autonomous night shifts. In that window the project went from a rules parser to a 35-workspace monorepo: neural parser, WOF resolver, formatter, record matcher, three drop-in API surfaces (Nominatim/Photon/libpostal), a browser runtime, and a coverage-tile pipeline.

Against the original plan, three drifts are worth naming plainly:

**The phase plan was abandoned, not completed.** `plan/README.mdx` says Phases 0–4 "shipped and superseded by the release train," and the live roadmap moved to a project board (epic #488). Meanwhile the phase directory accreted post-hoc phases (7, 8E, 8-fresh-slate — the v0.5.0 rebuild), and new architecture specs are still being written six weeks after "shipped" (`2026-06-29-joint-consistency-resolution.mdx`, edited today). The plan directory now describes a project that no longer exists in the shape it describes.

**Locale scope tripled past its own boundary.** The v1 scope was "US + France… Japanese is a deliberate Phase 6 stress test, not v1." Shipped reality: a 16-locale model (v4.13.0), Japan live in the resolver, Sweden queued as locale 17 pending license approval (#202). The multi-locale campaign became the main effort. It worked — but no document ever re-declared the scope, so every remaining plan artifact understates what the project is now responsible for maintaining.

**Whole workstreams appeared that the plan never mentioned.** Record matching (Fellegi-Sunter scorer, NPPES dedup benchmarks, epics #602/#603/#615/#625/#655), the client-side WASM geocoder demo, competitive benchmarks against Nominatim/Pelias/Photon. Individually justified; collectively a second product growing inside the first one's roadmap.

None of this is condemnation — scope expansion driven by real wins is how solo projects find their product. But an expanded scope with a frozen plan means every new contributor (and every future autonomous shift) orients against a map that is wrong.

---

## Risks, ranked

**R1 — Metric substitution without a re-anchor.** The north-star moved from label-F1 to "grade the coordinate, never label-F1" (v4.15.0 promotion doc). Defensible — the coordinate is what users get. But since the switch, five label-F1 regressions shipped as "coordinate-invisible" (three in v4.13.0, two postcode floors lowered in v4.15.0, each with written justification). Each call was individually sound and documented. The pattern is the risk: the label metric can now erode indefinitely as long as each step is small, because nothing forces a periodic full re-score. The ledger that would catch drift (`evals/scores-by-version.json`) stopped being populated at v4.4.0 and `AGENTS.md` still names it authoritative.

**R2 — The hardest model problem is stalled with no probe.** Slavic/accented diacritic tokenization is the dominant open defect: CZ 84% and PL 77% content-gap rates root-caused to mis-tokenization (`Grudziądz` splits at `ą` and eats trailing digits; `Montréal, QC` drops the `C`; `ß` splits). There is no CPU fix — it is a rendering/retrain lever (#825), deferred twice, and the shift notes themselves concluded "only the RENDERING fixes it." Every locale past the original scope makes this defect more expensive to leave open, and there is currently no cheap probe defined that would inform the go/no-go.

**R3 — The demo lies about the product.** #861 (browser cascade skips the joint-consistency passes) means the marquee resolver wins do not execute in the browser at all. #203 showed the demo can silently trail npm by two model versions. The stated long-term goal is that the demo _becomes_ the geocoder; today it is the least accurate rendition of the system that exists anywhere.

**R4 — Operator-gated decisions are accumulating.** #825 (GPU budget go/no-go), #875 (breaking `Us`/`Json` rename batch → next major), #861 (demo parity), #378 (blocked on Chrome hardware for in-browser P95), #379 (tar 7.x), the #493 serializer contract (#864), ODbL counsel sign-off (#260/B3), the Sweden license clock (#202). None are code-blocked. Several are weeks old. Each one an autonomous shift re-reads, re-defers, and re-documents costs real shift time — the backlog itself has a carrying cost.

**R5 — The record of record is stale.** `releases.mdx` said "4.11.0 (current)" while shifts referenced v4.15.0+; the last full parity scorecard is 2026-06-11; the two version series (npm 4.x/5.x vs training v0.x) still confuse, and the doc built to disambiguate them is itself out of date. Small individually; together they mean no single document currently tells the truth about the project's state.

**R6 — Focus discipline on breaking changes.** The v5.0.0 acronym sweep — a large, breaking, cosmetic rename — landed mid-campaign, produced 70 typecheck errors in diagnostic scripts, and immediately spawned a follow-on breaking batch (#875). The sweep itself is fine; landing it during an active model campaign, and shipping it incomplete, is the smell. Version-gated batches should ship whole or wait.

---

## Game plan

The ordering principle: **make the truth visible first, then decide, then spend.** Nothing below requires new architecture. Tracks 1–3 are days of work; Track 4 is the only item that costs training budget, and it comes last on purpose, gated by everything before it.

### Track 1 — Ship the truth to the demo (days, no retrain)

The single highest-leverage item in the backlog, because every win already shipped is discounted to zero until the demo serves it.

- **Fix #861:** route the browser cascade through the shared `resolveTree` joint-consistency passes (or extract those passes to a target both runtimes import). Acceptance: the #822 "City, Country" cases that resolve on the server resolve identically in the browser.
- **Close the version-lag class, not the instance:** add a release-train checklist item (or CI check) that fails when the demo's pinned model/package version trails the latest npm release. #203 was fixed once as an instance; make it structural.
- While in there, spend the small effort on #827 (progressive region centering / gazetteer cold-load) only if it falls out of the parity work — it is polish, not rail.

### Track 2 — Re-anchor measurement (days, CPU only)

R1 and R5 have the same fix: one full re-score and one documentation truth-pass.

- **Run a full per-tag parity re-score** against the current shipped model (v5.0.0 line) on the same golden slices as the v4.4.0 gate, and publish it as `parity-scorecard-2026-07-xx.md`. This re-baselines the "coordinate-invisible" ledger of deferred label-F1 debt in one shot: either the erosion is bounded (likely) and the pattern is vindicated, or it is not and we learn that now, cheaply.
- **Decide the ledger's fate explicitly.** Either repopulate `evals/scores-by-version.json` from the re-score and commit to updating it at every promote, or formally deprecate it and update `AGENTS.md` to name the actual authority (the latest parity scorecard + per-release model-cards). The current state — documented-canonical but null-filled — is the worst of both.
- **Truth-pass the three stale records:** `releases.mdx` current-version line, `status.mdx` (still quoting v4.4.0 tables per the 06-25 review), and the plan `README.mdx` — see Track 5.
- **Add the standing rule:** every N promotes (suggest 5) or any promote that lowers a gate floor triggers a full re-score. Write it into `CONTRIBUTING_MODEL_WORK.mdx` so it is a gate, not a virtue.

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

The output is not the decisions themselves — it is that autonomous shifts stop paying the re-triage tax.

### Track 4 — The #825 campaign, probe-first (the funded one)

The diacritic defect (R2) is the only thing on the board that requires training budget, and the falsified-lever discipline that served the project should apply to it before the spend:

- **Pre-register the gate before anything runs** (per `CONTRIBUTING_MODEL_WORK.mdx`): CZ/PL content-gap rate targets, a no-regression floor on the US/FR slices from Track 2's fresh scorecard, and the DE/`ß` and FR-accent cases (#727) as named slices.
- **Define the cheap probe first:** before a full multi-locale retrain, a bounded experiment that isolates the rendering hypothesis — e.g., a tokenizer-only rebuild (or byte-fallback coverage audit) scored against the failing CZ/PL spans on CPU, to confirm the failure is representational before buying GPU time to fix it. If the probe can't be defined, the shift notes' own rule applies: not ready to train.
- **Freeze locale expansion until this lands.** No locale 17 (Sweden waits on its license anyway) and no new locale shards before the rendering fix, because every added locale deepens the exact defect this campaign exists to fix.

### Track 5 — Re-declare the scope (one document, half a day)

Write the successor to `plan/README.mdx` — a short "what mailwoman is now" scope doc that: names the real locale set and its tiers; admits record-matching as a second workstream with its own epics rather than a footnote; states the demo-is-the-geocoder goal and its parity requirement (Track 1) as a standing invariant; and marks the phase directory as historical. The 06-25 review found the internals excellent and the front door fictional; the same is true one level up — the plan is the internal front door, and it should stop describing a US+FR parser.

### What not to do

- **No new resolver micro-levers past the frontier.** The shift notes already identified the residual as gazetteer name-key hygiene and exonym coverage (#877), not more levers — #781 measured +0.0pp and was correctly closed. Resist the treadmill.
- **No breaking cosmetic sweeps mid-campaign.** #875 waits for the major it is assigned to.
- **No new locales before the rendering fix** (covered above, worth repeating as a rule).
- **No new workstreams** until Tracks 1–3 are done. They total less than a week and everything else compounds on them.

---

## Sequencing

Tracks 1 and 2 are independent and can run in parallel (Track 1 is demo/runtime code; Track 2 is eval + docs). Track 3 needs an hour of operator time and can happen any day. Track 4 starts only after Track 2's re-score exists (its gates depend on the fresh baseline) and Track 3 sets its budget ceiling. Track 5 can be a night-shift deliverable once 1–3 have landed, so the new scope doc describes the re-railed state rather than promising it.

Success, four weeks out, looks like: the demo resolves what the server resolves; a 2026-07 parity scorecard exists and the ledger question is settled; the operator queue holds only externally-blocked items with check-back dates; and #825 has either a probe result and a funded gate, or a documented no-go. That is the project back on rails — not faster, but pointed where it is going.
