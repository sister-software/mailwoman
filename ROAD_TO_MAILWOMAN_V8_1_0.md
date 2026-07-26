# Road to Mailwoman v8.1.0 — parser architecture: retire the flag-pile, decide the long-term shape

**Status:** converged design → task-list source · **Track 2 ADJUDICATED 2026-07-26 → §8** ·
**Opened:** 2026-07-26 · **From:** 8.0.0 / bundle 6.6.3 / model v385 · **Authors:** Claude (brief) +
Kimi (response), operator-directed.

**Directive (operator):** an architecture we can stand behind long-term — one that parses a _variety_
of addresses competently — not a growing collection of opt-in/opt-out flags a consumer manages
blindly. The named failure mode to avoid: a _neuro-flavored Pelias rule hellscape_ (a model wrapped in
an ever-accreting pile of special-case priors, thresholds, and flags).

This roadmap merges the problem brief (`docs/superpowers/plans/2026-07-26-parser-architecture-problem-and-options.md`),
Kimi's response (`…-RESPONSE.md`), and the resulting decisions. It has **two tracks**: **Track 1
(hygiene) ships v8.1.0** — consolidate the decode surface and adopt a rule that stops the pile from
growing; **Track 2 (research) runs the cheap probes** that decide the long-term architecture and scope
the next major. §7 is the task-list seed.

---

## 1. The problem — two structural walls

**Wall A — training hits early encoder+head co-adaptation lock-in.** Five mechanisms to resurrect the
dead `dependent_locality` tag / make the model comma-robust (v3.10→v3.13) all falsified; three stop
rules. v3.13's verdict: no clean checkpoint — the `INV[comma-drop]` "Pennsylvania Ave" invariance
break is present byte-identical at every checkpoint, hot and annealed, established by ≤1k. The cRT
contrast (frozen encoder + same reinit + hot LR ⇒ clean at 6k) pins it: **the co-adaptation lives in
shared encoder representation**, not the head schedule. _"Resurrection recipes buy the board and pay
one invariance class."_ A flat single-head labeler can't absorb a capability _late_ without collateral.

**Wall B — decode-time evidence works closed-vocab, fails open-vocab, and accretes flags.** The
gazetteer-as-decode-prior layer (positive-evidence-only, per-country calibrated) shipped GB/NZ
`dependent_locality` in v8 with zero model change — but **structurally fails open-vocabulary** (venue
#1287, street #1288; comma-free trailing-locality #1317 went net-negative on held-out BAN population
because a person-name street is decode-time-indistinguishable from a trailing city). And it is
**accreting the flag-pile**: the placetype-pair prior (δ, transition-β, `(x,x)` identity rule,
`{at,of}` suppression, #1308 postcode strip), the FST emission prior + street-context gate (default-on
via #1318 behind a **bar-revision shipping −6.8pp FR homonym**), importance length-scaling (#1173),
and `ParseOpts.trailingLocality` (**opt-in**). ≥5 mechanisms, ≥2 consumer-visible flags, one live
regression riding a maintainer-promise.

**Synthesis:** the model can't absorb capabilities late (A); the decode layer that absorbs them
instead doesn't generalize and doesn't stay clean (B). Neither lever alone is a long-term architecture.

## 2. Constraints every option lives inside

1. **Browser inference budget.** onnxruntime-web (WebGPU→WASM), ~38 MB int8 model + ~21 MB FST. A
   materially bigger model or heavy per-token retrieval changes the client tier.
2. **No consumer-managed blind flags** — and its teeth (the **D-rule**, adopted): _no default-on
   mechanism ships with a known regression vs the shipped model on any tier-1 locale, full stop._ This
   makes the current #1318 FR default-on **non-compliant today** — a present action item, not a
   prospective one.
3. **Positive-evidence-only is _structural_ today, _curricular_ under Option A.** Decode-time priors
   only add positive score ⇒ absence provably never penalizes. The moment evidence is a learned input
   feature, absence becomes informative and the model can learn "no match ⇒ downweight" — soft-Pelias.
   Under A this guarantee must be **re-earned by training + gated** (evidence-ablation invariance), not
   assumed. This is the known RAG "retrieval over-trust" problem: real, but with established mitigations
   (feature dropout, retrieval-ablation training, counterfactual coverage).
4. **Beat Pelias without Elasticsearch, and without becoming Pelias.** Competence from _learned
   structure_, not a hand-maintained rule cascade.
5. **Invariance discipline + named held-out populations.** The metamorphic invariance suite is the
   standing gate. AND: every probe gate below **names its held-out population up front** — we've twice
   shipped a sign-flip because a hand-built board passed while held-out population reversed it (33-row
   comma-free vs 400-row BAN; v3101-cache vs v385). A success on a hand-built board is a candidate
   number, not a verdict.

## 3. The options (sharpened)

- **A — Retrieval-augmented _encoding_.** Gazetteer/registry matches become **input features the
  encoder learns to weigh**, collapsing the decode flag-pile into one learned channel; open-vocab
  becomes a feature ("matches a street lexicon") not an exact-match miss. The doctrinal target.
  **Sharpened:** the falsifying unit is a **feature _bundle_** (≥2 correlated channels — street-lexicon
  span + locality/pair-parent + affix), because one channel can't separate the two-sided open-vocab
  wall; and it ships **only** with an evidence-ablation gate (constraint 3).
- **B — Capacity / multi-head.** A structurally separate head (or more capacity) lets a late capability
  grow in its own subspace while the encoder stays shared — directly attacks Wall A. The #727 span-head
  result (+7.9pp) is prior evidence head structure matters. **Does nothing for Wall B** (if B succeeds
  and A never ships, the flag-pile remains).
- **C — Hierarchical decomposition.** Make segment → classify → resolve load-bearing (today it's
  advisory preprocessing). Cheapest to probe; its answer re-routes A and B.
- **D — Consolidate the decode surface into ONE default-on, self-calibrating mechanism + the D-rule.**
  The hygiene track. Not architecture — but it retires the flags, adopts the no-regression rule, and
  remediates the live #1318 violation. **Ships v8.1.0.**
- **E — Learned constrained decoding (data-derived grammar).** Ranked last; CRF tuition already paid
  (CE-only since v0.5.0). Probe optional; the moment it needs hand rules, it's the hellscape — stop.

## 4. Sequenced probes (Track 2 — research; run before ANY full training arc)

**Order: C → B → A. Each is ≤2k steps or zero-GPU. Each names its held-out population and its gate.**

### Probe C (zero-GPU, first — it re-routes everything)

- **Question:** are open-vocab failures mis-_segmentation_ or mis-_labeling_?
- **Method:** run shipped v385 over the named held-out set — 400-row `ban-fragments-fr` (open-vocab FR
  streets) + a US held-out slice. Per failure, compare model span boundaries to gold: **boundary
  correct + tag wrong = labeling; boundary wrong = segmentation.**
- **Decision:** mostly segmentation ⇒ C becomes the architecture, A/B are stage-2 concerns. Mostly
  labeling ⇒ C is dead, the A/B axis is the real one.
- **✅ VERDICT (2026-07-26): C is dead — 100% LABELING.** On ban-fragments-fr (2800 rows, expanded from
  the planned 400) all 906 misses are mis-labeling with correct boundaries ("Allée Bienville"→locality).
  On comma-free multi-component, fusion exists but is TYPE-COUPLED — cutting "des Lyonnais | Paris"
  requires knowing Paris is a city, so a type-agnostic segmenter can't make the cut. Axis is A/B.

### Probe B (≤2k steps, harness exists; cRT already did half of it)

- **Question:** does a _structurally separate_ head resurrect dep-loc without the comma-drop break that
  every flat-head recipe paid?
- **Method:** resume v385 with a fresh separate dep-loc head (own param group) vs the flat-head reinit,
  2k steps; run the invariance suite (`--baseline v385`).
- **Decision:** separate head resurrects without the break ⇒ lock-in is head-structural, B is live (and
  is A's enabler). Break persists ⇒ lock-in is deeper (encoder), B alone insufficient.
- **✅ VERDICT (2026-07-26): B insufficient — lock-in is ENCODER-DEEP.** The separate head (v3.14.0,
  merge-in-forward like the affix head, hot carveout LR, init_from v385, 2k) DID resurrect dep-loc but
  STILL paid the signature `us-white-house [comma-drop]` break + 6 more NEW invariance violations vs
  v385. Head-subspace separation does not protect the shared trainable encoder — the fresh head's
  gradient disturbs it anyway. Confirms the cRT contrast (the break needs a HOT encoder).

### Probe A (needs the bundle design from §3; last)

- **Question:** can the model learn a _joint weighting over an evidence bundle_ input-side, holding
  invariances AND the evidence-ablation gate?
- **Method:** take ≥2 correlated channels (street-lexicon span + locality/pair-parent), feed input-side,
  train small (frozen-encoder-then-head). Gate on: (a) the standard invariance suite, AND (b) a new
  **evidence-ablation invariance class** — parse with retrieval features zeroed ⇒ no regression vs
  features-present on spans that should be unaffected.
- **Decision:** bundle learns a useful weighting AND passes ablation ⇒ A is the long-term architecture.
  Fails ablation ⇒ soft-Pelias risk confirmed, needs curriculum work before it's viable.
- **✅ VERDICT (2026-07-26): A's MECHANISM CONFIRMED; the naked single channel over-trusts — proving
  the bundle + ablation gate are required, not optional.** Ran as a single-channel staged increment
  (street-type only — the locality channel is the effort risk, deferred to the build arc): a separate
  additive input channel from a codex street-type lexicon (483+164 surfaces, fr/us/gb/de/ca), init_from
  v385, 3k, graded via the ON/OFF feature contrast on the SAME checkpoint (fully controlled). Every P-C
  target class improves ON (admin-street-homonym **+0.058**, bare-street +0.035, date-name +0.055),
  stable across step-1500/3000; the negative control (bare-locality) is exactly 0.000. **BUT** the
  house-number classes are neutral at 1500 (−0.007/+0.003) and DECAY into regression by 3000
  (−0.070/−0.045): with more training the model over-trusts the lone feature — the predicted RAG
  retrieval-over-trust pathology, observed empirically. A naked input feature behaves like a soft rule
  (helps its target, disturbs neighbors) — Wall B's pathology re-expressed input-side. Constraint 3's
  "re-earned by training + gated" is now measured fact, not caution.

## 5. Track 1 — Option D, ships v8.1.0 (concrete now, no research gate)

1. **Adopt the D-rule** as a written standing gate: no default-on mechanism ships a known regression vs
   the shipped model on any tier-1 locale. (Doc it in AGENTS.md / the release gate.)
2. **Remediate the live #1318 FR violation** (the −6.8pp homonym) to comply: derive the FST gate weight
   **per-locale from the artifact header** so FR ships a self-calibrated (compliant) gate, OR gate FR
   harder / pull FR from default-on until a model clears it. Folds #1320 from "re-run someday" into a
   concrete deliverable.
3. **Consolidate the decode surface**: every current flag/knob (`trailingLocality`, `fstBiasScale`, the
   δ/β/`{at,of}`/identity levers, the bar-revision) becomes derivable from the artifact header + query
   shape — **zero consumer input**, or absent. Success test: no consumer-set flag remains, and no
   default-on mechanism carries a regression.

## 6. Cut criteria for v8.1.0

1. **Track 1 (D) complete** — the D-rule is a written gate; #1318 FR is compliant (no default-on
   tier-1 regression); the decode surface has zero consumer-managed flags; standing gates green.
2. **Track 2 probes reported** — C, B, and (if reached) A run with named held-out populations, verdicts
   recorded; a direction for the next major (v8.2/v9 architecture) named, not necessarily built.
3. Standing gates unchanged — golden byte-stable, invariance suite, gauntlet, presets; publish path
   intact.

Explicitly **not** gating v8.1.0: building the chosen architecture (A/B/C) — that's the next arc the
probes scope. v8.1.0 is "stop the pile growing + decide the shape."

## 7. Task-list seed

**Track 1 — Option D (ships v8.1.0):**

- [ ] D1: write the D-rule into the release gate + AGENTS.md (no default-on tier-1 regression).
- [ ] D2: #1318 FR remediation — per-locale artifact-header gate weight (or gate-harder/pull-default);
      re-run the #1318 battery to prove FR compliant. Closes #1320's spirit.
- [ ] D3: decode-surface consolidation — retire `trailingLocality` + every hand knob into
      header-derived self-calibration; guard: zero consumer flags remain.

**Track 2 — probes (research; strictly C → B → A) — ALL COMPLETE 2026-07-26:**

- [x] P-C: segmentation-vs-labeling split on named held-out (ban-fragments-fr 400 + US slice). Zero-GPU.
      **→ C dead: 100% labeling; fusion is type-coupled.**
- [x] P-B: separate-head dep-loc resurrection, 2k steps, invariance `--baseline v385`.
      **→ B insufficient: comma-drop break persists; lock-in is encoder-deep.**
- [x] P-A: evidence-bundle input-side probe + the new evidence-ablation invariance gate.
      **→ A mechanism confirmed (staged single-channel); naked channel over-trusts ⇒ bundle + gate required.**
- [x] Synthesis: name the next-major architecture direction from the three verdicts. **→ §8.**

**Discipline (carried in):** probe before any full run (5 falsifications is the tuition); every gate
names its held-out population; treadmill guard (no third same-axis run solo); positive-evidence-only is
structural today and must be re-earned + gated under A.

**Pointers:** the brief + Kimi's response (`docs/superpowers/plans/2026-07-26-parser-architecture-*`);
v3.13 verdict + cRT (`.superpowers/sdd/progress.md`); dep-loc redesign dossier
(`2026-07-23-deploc-redesign-dossier.md`); decode mechanisms in
`neural/{placetype-pair-prior,fst-prior,trailing-locality-prior}.ts`.

---

## 8. Adjudication — the named direction (2026-07-26)

**The next-major architecture is Option A: retrieval-augmented ENCODING.** All three probes, run in
one day (P-C zero-GPU; P-B + P-A ≈ 7 min A100 each), converge from independent directions:

- **P-C** eliminated C and located the failure: street↔locality discrimination for open-vocab spans is
  a **labeling/evidence** problem, not a segmentation one — and the segmentation errors that do exist
  are type-coupled, so only better typing fixes them too.
- **P-B** eliminated standalone B: the Wall-A lock-in lives in the shared encoder representation, so no
  head topology routes around it. Late-capability absorption needs the capability's **evidence in the
  input**, not another output subspace. (Head structure may still earn its keep inside an A build — the
  #727 span-head +7.9pp stands — but it is not the axis.)
- **P-A** demonstrated the mechanism works exactly where predicted (every P-C target class up, negative
  control silent at precisely 0.000) — and demonstrated the failure mode of doing it naively: a single
  naked channel drifts into over-trust with training (house-number classes −0.070/−0.045 by 3k). One
  probe produced both the existence proof and the design constraint.

**The design that follows (the next arc, not v8.1.0):**

1. **The evidence bundle** — street-type (built, committed: `data/gazetteer/street-type-lexicon-v1.json`
   - the model/loader/trainer channel plumbing, all default-False at c116f9d1) **+ the locality
     channel** (open-vocab; per-span FST/gazetteer lookup as a training feature — the effort risk and the
     main build item). No single channel may be decisive by construction.
2. **The evidence-ablation invariance gate** — features-zeroed vs present ⇒ no regression on unaffected
   spans — promoted from "Kimi's caution" to a **measured requirement** by the P-A decay. It enters the
   standing gate battery the first time an A-trained model is graded, alongside anti-over-trust
   curriculum (feature dropout / retrieval-ablation training).
3. **The payoff that makes A the anti-hellscape:** each decode-time mechanism the flag-pile carries
   (FST emission prior + gate, pair prior, trailing-locality) is a candidate for **retirement into the
   learned channel** — the model weighs the evidence in context instead of a threshold weighing it
   blind. Track 1 (D) still ships v8.1.0 first: the pile must stop growing while the replacement is
   built.

**Sequencing note:** the probes were run against Track 2's original C→B→A order and are complete;
Track 1 (D1–D3) remains the v8.1.0 gate and is untouched by this adjudication. The A build arc
(locality channel + ablation gate + curriculum) is scoped as the v8.2/v9 architecture arc —
productionization routed per the operator's Track-2 delegation.
