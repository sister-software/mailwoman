# Parser architecture — the problem, the two walls, and the options

**Date:** 2026-07-26 · **For:** Kimi (design lead) + operator · **From:** Claude · **Status:** design
brief, not a decision. **Framing directive (operator):** favor an architecture we can stand behind
long-term — one that parses a _variety_ of addresses competently — over a growing collection of
opt-in/opt-out flags a consumer manages blindly. The failure mode to avoid by name: a
_neuro-flavored Pelias rule hellscape_ (a model wrapped in an ever-accreting pile of special-case
priors, thresholds, and flags).

This brief states the problem precisely from the receipts, names the two structural walls we've hit,
lays out the design constraints, and enumerates architectural options with the falsifiable probe each
one needs. It deliberately does **not** pick one — that's the discussion this is meant to seed.

---

## 1. The problem in one paragraph

Mailwoman is a calibrated, retrieval-augmented BIO sequence labeler: a SentencePiece + encoder +
classifier-head model that tags address tokens (`house_number`, `street`, `locality`, `region`,
`dependent_locality`, …), with a semi-Markov/Viterbi decode. To parse the long tail of address forms
(comma-free "street + trailing city", dependent-locality hierarchies, bare streets, person-name
streets, POI/venue prefixes, non-US admin splits), we've pushed on two levers — **teach the model
(training)** and **bias the decode with gazetteer evidence (decode-time)**. Each has hit a
_structural_ wall, and the second one is quietly accreting the exact flag-pile the operator wants to
avoid. The architectural question: **what shape lets one model own a variety of address grammars
without a training treadmill on one side or a rules-hellscape on the other?**

## 2. The two walls (with receipts)

### Wall A — training hits early encoder+head co-adaptation lock-in

Five mechanisms were tried to resurrect the dead `dependent_locality` tag (GB/NZ) and make the model
comma-robust, across v3.10→v3.13; **all five falsified, three stop rules**:

- reinit_label_rows + classifier param-group LR; class-weight lifts; comma-free augmentation matched
  to the corpus's 37.7% comma-free share (v3.12); a two-phase classifier-LR schedule (hot 2k window
  then anneal, v3.13).
- **v3.13 verdict:** no clean checkpoint. The `INV[comma-drop]` "Pennsylvania Ave" invariance break is
  present **byte-identical at all 8 checkpoints, hot AND annealed**, established by ≤1k, stable (not
  accumulating). The cRT contrast (frozen encoder + same reinit + hot LR ⇒ clean at 6k) pins the root
  cause: **early encoder+head co-adaptation lock-in**, not a tuning problem.
- The crisp tension: _"resurrection recipes buy the board and pay one invariance class."_ Best-ever
  dep-loc (69/69 emit, FP 0) always came with a broken comma-drop invariance. This is a
  capacity/plasticity constraint of the flat single-head labeler — late capability injection disturbs
  a co-adapted representation and something else regresses.

### Wall B — decode-time evidence works for closed-vocab, fails for open-vocab, and accretes flags

To ship the capabilities training couldn't, we bolted gazetteer evidence onto the _decode_ (positive
evidence only, per-country calibrated, model still owns ambiguity — the "registry-backed structured
prediction" doctrine). It genuinely works for **closed-vocabulary retrieval** (place names): GB/NZ
`dependent_locality` shipped in v8 via a pair-index prior, zero model change. But:

- It **structurally fails for open-vocabulary** spans — venue names (#1287) and street names (#1288)
  can't be matched by a place-pair index; and comma-free trailing-locality (#1317) went net-negative
  on held-out BAN population because a person-name street ("Avenue Marceau Julien") is _decode-time
  indistinguishable_ from a trailing city ("Rue des Lyonnais Paris") — identical Affix-Name-Name
  syntax, and the surname _is_ a gazetteer locality. No decode geometry separates the classes.
- It is **accreting exactly the flag-pile the directive warns against.** Current decode-time surface:
  the placetype-pair prior (δ magnitude, transition-β, the `(x,x)` identity rule, `{at,of}`
  title-preposition suppression, the #1308 trailing-postcode strip), the FST gazetteer emission prior
  - street-context gate (default-on via #1318 behind a **dated bar-revision** that ships a −6.8pp FR
    homonym regression on a promise), importance length-scaling (#1173), and `ParseOpts.trailingLocality`
    (**opt-in**, off by default). That's five-plus mechanisms and at least two consumer-visible flags,
    each principled in isolation but collectively drifting toward "a model + a rulebook."

**The synthesis both walls point at:** the model can't absorb capabilities _late_ (Wall A), and the
decode layer that absorbs them instead doesn't generalize and doesn't stay clean (Wall B). Neither
lever alone is a long-term architecture.

## 3. Design constraints (the box any option lives in)

1. **Inference size / runtime.** The browser demo runs onnxruntime-web (WebGPU→WASM) with a ~38 MB
   int8 model + a ~21 MB FST. A materially bigger model or a heavy per-token retrieval changes the
   client story. Server paths are freer, but the browser bar is real.
2. **No consumer-managed blind flags.** Whatever ships should be default-on and self-calibrating, or
   absent — not a `trailingLocality: true` a caller must know to set, nor a bar-revision that ships a
   regression "until the next model fixes it."
3. **Positive-evidence-only + model-owns-ambiguity.** The standing doctrine: registries are soft
   priors and coverage, never hard overrides; absence never penalizes; the model makes the call. Any
   option must preserve this or argue explicitly for changing it.
4. **Beat Pelias without Elasticsearch, and without becoming Pelias.** The north star is a production
   geocoder whose competence comes from _learned structure_, not a hand-maintained rule cascade. An
   option that's "a grammar of per-country rules" has to earn its keep against that allergy.
5. **Byte-stability / invariance discipline.** The metamorphic invariance suite (comma-drop,
   case-fold, idempotence, …) is the standing gate. An architecture that can't hold invariances under
   capability growth is the Wall-A failure by another name.

## 4. Architectural options

Each is stated with its core idea, why it could break a wall, its cost/risk, and **the cheap probe
that would falsify it before a full build** (diagnostic-first — we've paid for skipping this).

### Option A — Retrieval-augmented _encoding_ (move the gazetteer from decode to input)

**Idea:** Instead of biasing the Viterbi lattice after the model, feed gazetteer/registry matches as
**input features the encoder sees** (per-token: "this span matches a known locality / street-suffix /
pair-child under this parent"), and let the model _learn_ to weigh them. This is the doctrinal
end-state of "retrieval-augmented sequence labeler" taken fully to the input side. The pile of
decode-time priors collapses into **one learned channel**; there are no consumer flags because the
model consumes the evidence internally; open-vocab is handled because the feature says "matches a
street lexicon" without needing an exact place-pair.

**Breaks which wall:** B (unifies the flag-pile into one learned mechanism; open-vocab becomes a
feature, not an exact-match miss). Possibly A (the capability lives in the _input distribution_, not a
late-resurrected head — the model may learn it during normal training without the co-adaptation shock).

**Cost/risk:** re-introduces training (the model must learn to use retrieval features); retrieval
must run at inference (a lexicon/FST probe per token — we already do this for the FST, so cost is
bounded); feature design + the training curriculum are the work. Risk: if trained naively the model
may _over-trust_ the feature (a soft-Pelias-in-disguise) — mitigated by feature dropout / counterfactual
augmentation so it learns the feature is advisory.

**Falsifying probe (cheap):** we already have anchor-lexicon + gazetteer features as inputs for some
channels. Take ONE decode-time prior currently bolted on (e.g. the street-context gate signal) and
train a small run with it as an _input feature_ instead, frozen-encoder-then-head. Measure: does the
model learn to use it without the comma-drop invariance break? If a single-feature input-side probe
holds invariances where the decode-side prior needed a flag, Option A is live.

### Option B — Capacity / multi-head architecture (break the co-adaptation lock-in)

**Idea:** Wall A is a plasticity limit of a flat single head. Give the model either more capacity
(wider encoder) or **structurally separated heads** (e.g. a coarse admin head vs a fine
street/dep-loc head, or an auxiliary "span-type" head) so a late capability can be grown in its own
subspace without disturbing the co-adapted one. The #727 span-head arc already showed a _trained span
head beats flat BIO_ (+7.9pp) — evidence that head structure matters.

**Breaks which wall:** A (capability injection gets its own parameters; the Pennsylvania invariance
lives in a head that isn't being disrupted).

**Cost/risk:** bigger/slower (the browser constraint); multi-head training is finickier; may just move
the co-adaptation boundary rather than remove it. Doesn't by itself address Wall B (the decode flags).

**Falsifying probe:** resume v385 with a fresh _separate_ dep-loc head (own param group) vs the
flat-head reinit, 2k steps, and run the invariance suite. If the separate head resurrects dep-loc
_without_ the comma-drop break that every flat-head recipe paid, the lock-in is head-structural and
Option B is live. (This is close to a probe we have the harness for.)

### Option C — Two-stage / hierarchical decomposition

**Idea:** Replace the one flat labeler-plus-decode-patches with clean stages: (1) segment/boundary,
(2) type-classify each segment, (3) resolve/attach. Each stage is individually trainable and testable;
the gazetteer enters at the resolve stage as retrieval, not as a lattice patch. Some of this already
exists as preprocessing (normalize → query-shape → kind → phrase-grouper); the proposal is to make the
decomposition _load-bearing_ rather than advisory.

**Breaks which wall:** B (evidence has a clean home — the resolve stage — instead of ad-hoc priors);
partially A (smaller per-stage models co-adapt less).

**Cost/risk:** stage boundaries leak (a segmentation error poisons downstream); more moving parts;
risks re-introducing rules at the segmentation stage (the Pelias smell) if segmentation isn't learned.

**Falsifying probe:** take the current phrase-grouper output as a fixed stage-1 and measure how much
of the open-vocab failure (venue/street/comma-free) is a _segmentation_ problem vs a _classification_
problem. If most failures are mis-segmentation that a clean stage-1 fixes, Option C is live; if the
model segments fine and mis-_labels_, C doesn't help and the problem is representational (A/B).

### Option D — Consolidate the decode surface into ONE default-on, self-calibrating mechanism

**Idea:** The minimal-change option. Keep the hybrid, but **retire every consumer flag and every
per-mechanism knob** into a single, always-on, header-driven evidence layer that self-calibrates per
country from the artifact (no `trailingLocality: true`, no bar-revisions, no δ/β to hand-set). This
doesn't fix the walls; it directly addresses the _"blind flags"_ half of the directive while the real
redesign (A/B/C) is scoped.

**Breaks which wall:** neither (it's hygiene, not architecture) — but it removes the hellscape _smell_
and buys time.

**Cost/risk:** low; it's refactoring + a calibration story. Risk: lipstick — if the underlying priors
are still a pile, consolidating their _surface_ doesn't make the _architecture_ long-term.

**Falsifying probe:** n/a — this is a refactor, gated by "can every current flag be derived from the
artifact header + query shape with zero consumer input?" If yes, it's a clean win regardless of A/B/C.

### Option E — Learned constrained decoding (a per-country grammar the model _scores_)

**Idea:** Express address structure as a soft, per-country grammar/CRF-transition prior that the model
_learns_ (not hand-writes), constraining the decode to plausible component orders. This is the most
"structured" option and the one closest to the Pelias tripwire — it's only defensible if the grammar
is _learned/derived from data_, never hand-authored.

**Breaks which wall:** B (one grammar mechanism vs many priors) — but only if learned.

**Cost/risk:** high tripwire risk (this is how you become Pelias); CRF training already diverged once
in this project (CE-only since v0.5.0). Include mostly for completeness and to name the boundary.

**Falsifying probe:** derive the transition grammar purely from the corpus (per-country component-order
statistics) and measure whether it improves open-vocab parse recall on held-out data _without_
hand-tuning. If a data-derived grammar helps and stays hands-off, E is live; the moment it needs
per-case hand rules, it's the hellscape and we stop.

## 5. A lens for choosing (not a decision)

- If the belief is _"the evidence should be learned, not patched"_ → **Option A** is the doctrinal
  target; B is its enabler if capacity is the blocker.
- If the belief is _"the model just can't hold it all in one head"_ → **Option B** first, then A.
- If the belief is _"the failures are structural/segmentation"_ → prove it with the **C** probe first;
  it's cheap and re-routes everything.
- **Option D is orthogonal and worth doing regardless** — it's the direct answer to "no blind flags,"
  and it can ship while A/B/C are researched. It is the one thing here that is pure win.

The through-line the directive asks for: **make the retrieval a first-class, learned, always-on part
of the model (A, enabled by B if needed), and collapse the decode-time flag-pile into it (D as the
interim) — so competence comes from learned structure, not a rulebook.** That is the opposite of the
Pelias hellscape and the thing we can stand behind.

## 6. What Kimi should weigh / decide

1. Which wall is the binding constraint to attack first — representational (A/B) or surface-hygiene
   (D)? They're not mutually exclusive; D can proceed in parallel.
2. Is inference-size headroom available (does A's per-token retrieval + any B capacity bump fit the
   browser budget, or does the browser demo become a reduced-capability tier)?
3. Run the cheap probes (§4) _before_ any full training arc — every one is ≤2k steps or zero-GPU, and
   the last five full runs taught us not to skip this.

**Pointers:** the v3.13 verdict + cRT diagnostic (`.superpowers/sdd/progress.md`, the v3.13 two-phase
arc entry); the dep-loc redesign dossier (`docs/superpowers/plans/2026-07-23-deploc-redesign-dossier.md`);
the registry-backed-structured-prediction doctrine + the #727 span-head result; the decode-time
mechanisms in `neural/{placetype-pair-prior,fst-prior,trailing-locality-prior}.ts`.
