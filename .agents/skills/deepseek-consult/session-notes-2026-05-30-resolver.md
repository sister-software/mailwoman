# DeepSeek consult — resolver routing + end-to-end eval (2026-05-30)

## Turn 1 (prompt)
You are advising on the architecture of a postal-address parsing + geocoding system ("mailwoman"). I need a concrete design, ending (over several turns) in an execution plan. This turn: orient and answer the 4 questions at the end. Be thorough.

THE SYSTEM (all shipped, in a TS monorepo):
- TWO parsers, DIFFERENT output contracts:
  1. v0 — rule-based, Pelias/addressit-derived. `parse(text) -> solutions[]`, each solution has `.classifications`: a FLAT record `{tag: string[]}` (e.g. {house_number:["350"], street:["5th Ave"], locality:["New York"], region:["NY"], postcode:["10118"]}). Multi-solution (ranked alternatives). No hierarchy.
  2. neural — 25M-param BIO encoder + Viterbi. `parse(text) -> AddressTree`: a NESTED containment tree (locality contains street contains house_number, etc.), single result. 33 component tags.
- A shipped WOF (Who's On First) resolver: `resolveTree(tree: AddressTree) -> AddressTree` decorated with WOF place IDs + lat/lon + runner-up alternatives. It walks the tree top-down with PARENT-CONSTRAINT INHERITANCE (a child "Springfield" under a resolved "Illinois" is scoped to IL descendants), bounded by maxLookups. Ranking = SQLite FTS5 BM25 + population weight + proximity + placetype/country match + length penalty. Coverage: US admin (142k places) + US postcodes. It resolves ADMIN levels (locality/region/postcode/country), NOT street/house-number. CRUCIAL: the resolver consumes an AddressTree (neural's native output); v0 produces flat ClassificationRecord[], so feeding v0 to the resolver needs a flat->tree adapter (build containment via a PARENT_OF table).
- A runtime pipeline normalize -> queryShape -> classify -> resolve, with a SINGLE classifier slot (currently neural only). v0 is NOT wired into it.

THE EMPIRICAL FINDING that motivates this work — a "capability map" from 3 unbiased eval arenas (our own 376-assertion suite is a Pelias-port, so it can't reveal where neural beats v0):
- libpostal (clean/canonical adversarial cases, non-Pelias lineage): v0 29% > neural 16%. RULES WIN on clean/canonical/in-gazetteer input.
- corpus-perturbation (clean addresses with delimiters stripped / lowercased / region+postcode glued): NEURAL 61% > v0 39%; on glued "NY14201" v0 0% / neural 62%. NEURAL WINS on noisy/degraded input.
- postal-standards edge formats (military APO/FPO, PO-box, rural-route): both weak (v0 26% > neural 8%), big coverage gaps.
Conclusion: NEITHER parser dominates; INPUT QUALITY determines the winner. Neural is the robustness layer for the messy long tail; rules win on clean canonical input.

THE GOAL (operator-chosen, US-first):
1. Build a PER-INPUT ROUTING layer that decides rules-vs-neural (or fuses them) based on input quality, feeding the resolver — operationalizing the capability map. Today the pipeline is neural-only, so v0's win on clean input is left on the table.
2. Build an END-TO-END eval: "address string -> correct WOF place + coords", to PROVE the routing helps. We have NO end-to-end accuracy number today (the resolver has unit tests but nothing measures whole-stack correctness). Ground-truth must be bootstrapped.

QUESTIONS (this turn):
Q1. Routing signal. Options: (a) a cheap lexical/heuristic "input quality" classifier (presence of commas/delimiters, canonical casing, gazetteer-token hits, digit/postcode shape) computed pre-parse; (b) run BOTH parsers and pick by a downstream signal; (c) a small learned meta-classifier. Which, and why? The "quality" axis is fuzzy — how do you make the signal robust and debuggable?
Q2. Route vs Fuse. Should we pick ONE parser's output per input (routing), or FUSE (e.g. take v0's clean component spans + neural's coverage into a single tree) before resolving? The resolver consumes one tree. Is fusion worth the complexity, or does routing capture most of the gain?
Q3. Resolver-as-arbiter. Instead of (or in addition to) a pre-parse quality signal: run BOTH parsers, resolve BOTH, and pick the resolution with the best gazetteer support (population/FTS score/parent-consistency/how many components resolved). I.e. make RESOLVABILITY the routing signal — let the gazetteer judge which parse was better. Is this sound? Failure modes? Cost (2x parse + 2x resolve) acceptable for a server-side geocoder?
Q4. End-to-end eval design. Ground truth + metric. Is bootstrapping from WOF sound: sample WOF places (with their hierarchy + coords), render them into address strings (canonical AND perturbed variants, to exercise both arena regimes), then measure resolution accuracy@1 + coordinate error vs the source WOF id? Plus: resolve our 4561-row labeled golden set and measure plausible-resolution rate? What's the right primary metric (acc@1 on WOF-id / MRR / km-error), and what baselines should I report (neural-only vs v0-via-adapter vs routed vs resolver-as-arbiter)?

## Turn 1 (response)
## Mailwoman Architecture – Routing, Fusion, and E2E Eval Design

This is a classic two-model system where one is robust to noise and the other is precise on clean input. Your capability map already quantifies the trade‑off. The goal is to ship a **per‑input decision layer** that consistently routes to the best parser, without adding unsustainable complexity, and to prove the whole stack works with a meaningful end‑to‑end metric. I’ll answer the four questions with concrete recommendations and trade‑offs.

---

### Q1. Routing Signal

**Recommendation: Use a cheap, pre‑parse lexical/heuristic quality classifier with a confidence‑gated fallback to dual‑parse + resolver‑arbiter.**  
Do not start by running both parsers on every request (latency and cost); do not jump to an opaque learned meta‑classifier without labelled per‑input “which parser would win” data.

The routing problem is: “is this input clean/canonical enough that v0 will outperform neural?”  
That’s a **surface signal problem**—canonical casing, presence of standard delimiters, postcode‑like digits, and hits against a small gazetteer index. You can capture that with a **small number of interpretable, hand‑crafted features**:

- comma / newline count
- ratio of capital‑letter words
- contains a token that matches a known locality/region/postcode (from a bloom filter or FST of WOF places)
- presence of a digit‑pattern that looks like a ZIP (5‑digit, 5+4, etc.)
- word‑length distribution (very short tokens suggest glued region+postcode)

These features can be combined into a **scalar “canonical‑ness” score** (0 … 1) using a minimal logistic regression trained on a few hundred hand‑labelled instances where you know which parser triumphs. The regression serves only to **calibrate thresholds**; it is not a black‑box replacement of the features. You get:

- **Interpretability & debuggability** – every decision can be traced back to the feature values.
- **Low runtime overhead** – no extra parsing; features are O(n) on the raw string.
- **Confidence gating** – define high‑confidence “clean” (>0.8 → v0), high‑confidence “noisy” (<0.2 → neural), and a narrow “ambiguous” band where you run **both parsers and arbitrate via the resolver** (see Q3). This caps the dual‑parse cost to a small fraction of traffic.

Why not (b) only? Running both parsers and then deciding downstream means you already paid the neural inference cost, which dominates. Why not (c) purely? A black‑box classifier would need many labelled “v0 wins / neural wins” examples that you don’t yet have, and would be harder to fix when it makes a wrong guess. The hybrid above gives you the best of both: fast, explainable routing with a safety net for edge cases.

---

### Q2. Route vs Fuse

**Recommendation: Start with routing + resolver‑arbiter; leave fusion as a possible phase‑2 optimisation.**  
Routing captures the low‑hanging fruit: on over half of real‑world volume the input is either clearly clean or clearly degraded, and picking the right parser yields the gain with zero composition complexity.

Fusion (creating a single tree from both parses’ best components) is seductive but carries deep risks:

- The resolver *strictly* consumes an `AddressTree` with a containment hierarchy. Merging a flat `ClassificationRecord` from v0 into a tree requires a **parent‑of mapping** (e.g., “if house_number exists, it’s a child of street, which is a child of locality”). This mapping is heuristic and brittle. A mistmatch (e.g., a street wrongly nested under a region) poisons parent‑constraint inheritance, which is the resolver’s main strength.
- Even if you can build a clean tree from v0 alone, deciding *which* spans to take from which parser introduces a new meta‑model with its own errors.  
- The gain over routing is likely small: the real‑world inputs where *parts* of the address are clean and others are noisy (e.g., “350 5th Ave New York, Ny 10118” vs “350 5th ave new york ny10118”) are exactly the ones that neural already handles well. The cases where v0 gets the street/house right but neural fails, and the resolver can’t fix it, are rare.

Instead, invest in **arbitration through the resolver** (Q3). It is a far safer and more powerful mechanism: you let the gazetteer be the ultimate judge, and you don’t have to design a fragile tree‑merger. If later evaluation shows a measurable delta in “fuse‑able” inputs, you can revisit fusion as a targeted fix (e.g., only fuse high‑confidence postcode/region from v0 into neural’s tree when neural’s postcode is missing).

---

### Q3. Resolver‑as‑Arbiter

**This is sound, powerful, and should be the primary arbitration mechanism—but not the default online path.**  
Here’s why:

*Soundness*  
The system’s goal is not parse correctness; it is **correct WOF place assignment with coordinates**. The resolver already knows how to score a tree against gazetteer evidence (population, BM25, parent consistency, etc.). If you run both parsers, resolve both trees, and pick the result with the higher **resolver confidence score**, you are directly optimising the end‑goal. That is more reliable than a pre‑parse quality signal that only proxies for parser performance.

*Failure modes*  
- **Both trees may resolve to *different* plausible places**, and the resolver may pick the wrong one with high confidence (e.g., two similarly named localities in different states). Parent‑constraint and population weights mitigate this, but it’s still possible.  
- **When both parses are garbage**, the resolver may still produce a “best” result—ranking garbage still gives a garbage top‑1. You need a minimum confidence threshold to reject such outputs entirely.  
- **Confidence score calibration**: the resolver’s score is not a probability. You must calibrate it on a held‑out set to know what score threshold corresponds to acceptable precision.

*Cost*  
Running two full parses (one of them a 25M‑param neural model) and two full resolution passes will roughly double the latency. For a server‑side geocoder, this is acceptable **only if the ambiguous‑band size is controlled**. With the routing banding from Q1, you can afford to run both on, say, 5–10% of traffic. Making resolver‑arbiter the *default* for all inputs is costly and unnecessary.

**Use resolver‑as‑arbiter in three places:**

1. **Online fallback** for the ambiguous quality band (neither “very clean” nor “very noisy”).  
2. **Offline training signal** for the per‑input quality classifier (Q1c) – you can automatically label a corpus with “v0 wins / neural wins” by running both, resolving both, and comparing resolver scores.  
3. **End‑to‑end evaluation baseline** (Q4) to show the ceiling of what’s achievable by always having an oracle choose the best resolution.

---

### Q4. End‑to‑End Eval Design

You need a benchmark that is **independent of the Pelias lineage** and reflects your operator’s US‑first target. The proposal to bootstrap from WOF is perfectly aligned with that. I would structure it as follows:

#### Ground‑truth generation

1. **Sample a stratified set of WOF places** covering the full hierarchy: a few thousand localities, regions, postcodes, and a handful of countries. Ensure urban/rural balance, diverse states, and some edge‑of‑coverage areas (Alaska, Hawaii, territories).  
2. **Render each place into canonical address strings** using multiple templates that vary the level of detail:  
   - “{house_number} {street}, {locality}, {region} {postcode}” (full)  
   - “{locality}, {region} {postcode}” (no street)  
   - “{region} {postcode}” (state + ZIP only)  
   For house_number and street, use real USPS ranges/common names to avoid obviously fake addresses that the resolver might not handle.  
3. **Create perturbed variants** for each canonical string to exercise the “noisy” arena:  
   - All lowercase, no commas  
   - Region+postcode glued (“NY14201”)  
   - Postcode mis‑split (“350 5th Ave 10 118”)  
   - Minor OCR errors (substitutions, missing charcters)  
   - Leading/trailing whitespace and gratuitous punctuation  
4. The ground‑truth label for each string is the **WOF ID of the most specific place that address is intended to represent**. For a full address, that is the locality (or the street if you ever resolve to street‑level, though your resolver currently doesn’t). If the template omits street, the label is the locality anyway; if it’s a state+ZIP only, the label is the region/postcode. You can store a list of acceptable ancestor IDs (e.g., if you only specify city, state and ZIP, the locality must match, but you could also accept the postcode’s parent locality). This eases the evaluation.

#### Metrics

**Primary metric: Place‑Match Accuracy@1 (strict and hierarchy‑tolerant)**

- **Strict**: resolved WOF ID exactly equals the ground‑truth place ID.  
- **Tolerance 1**: resolved ID is a direct ancestor (e.g., returned county when we asked for locality) up to the expected specificity. You can define a mapping: for a template that includes locality, accept locality ID or its parent (county/region) but not the country. This avoids penalising reasonable approximations.  
- **Coordinate error**: For all correct and tolerated matches, compute great‑circle distance between resolved lat/lon and the source WOF centroid. Report **median (p50) and p90** in kilometres. For incorrect matches, compute distance anyway to give a full picture.

**Secondary metrics** (for diagnostics, not headline):

- **Resolution success rate**: whether the resolver returned any WOF ID (non‑null) with confidence above a threshold.  
- **Component‑level F1** on the parsed tree (house_number, street, locality, region, postcode) before resolution, to isolate parser errors from resolver errors.  
- **Resolver parent‑consistency rate**: how often the resolved place is a valid parent in the hierarchy given the parsed components.

#### Baselines to report

| Baseline | Description |
|----------|-------------|
| **neural‑only** | Current pipeline (neural tree → resolver) |
| **v0‑via‑adapter** | v0 flat parse → tree adapter → resolver |
| **Quality‑router (heuristic)** | The lexical quality score from Q1 with thresholds, no fallback to dual‑parse |
| **Quality‑router + arbiter** | As above, but run both and arbiter on the ambiguous band |
| **Resolver‑arbiter (full)** | Run both parsers, resolve both, pick best score (upper‑bound for online systems) |
| **Oracle** | Always pick the parser whose resolution yields correct place (gives the achievable ceiling given perfect routing) |

The routed baselines should show error‑reduction on both the canonical and perturbed subsets relative to the single‑parser baselines, and the arbiter should approach the oracle. The primary metric with hierarchy‑tolerant accuracy plus coordinate error gives a clear story for stakeholders.

#### Bootstrapping notes

The WOF‑sourced eval set is **unbiased** by the Pelias lineage and can be extended to the postal‑standards edge formats (PO Box, rural route) by explicitly rendering those patterns using USPS syntax and including them in the sample. This will expose the coverage gaps you’ve already identified and prevent the illusion of progress.

The existing 4561‑row “golden set” (Pelias‑derived) is useful only as a **regression detector** for Pelias‑compatible inputs. It should not be the primary metric because it overestimates v0’s strength and masks neural’s advantages. Use it to ensure you don’t backslide on the “clean” arena.

---

### Summary Architecture To Move Forward

1. Build the **per‑input quality scorer** (lexical features + tiny LR) with an ambiguous band.  
2. Implement the **routing switch** that calls v0, neural, or both.  
3. Integrate the **resolver‑arbiter** inside the ambiguous band, returning the result with the higher resolver confidence.  
4. Construct the **WOF‑bootstrapped evaluation harness** with the metrics described above.  
5. Tune the routing thresholds to maximise Place‑Match Accuracy@1 on the eval set.  
6. Ship the routed pipeline and publish the end‑to‑end numbers alongside the single‑parser baselines.

This plan lets you operationalise the capability map without over‑engineering, while keeping a clear path toward fusion if warranted by future data.

## Turn 2 (prompt)
Strong. I'm adopting: lexical canonical-ness scorer + confidence bands, resolver-as-arbiter on the ambiguous band (+ as offline auto-labeler + eval oracle), WOF-bootstrap eval, golden set as regression-only. Four follow-ups to harden it before I write the plan.

Q5. Eval circularity. The WOF-bootstrap renders WOF place strings and resolves them BACK to WOF ids. That stresses the parser (canonical+perturbed) and the resolver's RANKING among 142k candidates (real Springfield-style ambiguity), so it's not fully circular — but the "addresses" are synthetic (WOF names + synthetic house/street) and never test real-mail messiness or real coordinates. Proposal: add a SECOND eval track from OpenAddresses (open US data: real {address string, lat/lon} pairs, independent of WOF's gazetteer). Even though the resolver is admin-only, I can measure great-circle error from the resolved locality/postcode centroid to OA's real point — an independent end-to-end signal. Is the OA track worth the ingestion cost, or do WOF-bootstrap + golden already give a trustworthy enough end-to-end number for a first milestone? If OA is worth it, what's the minimum viable slice (how many points, what sampling)?

Q6. Build order. I think the eval harness MUST come first (can't tune router thresholds or prove anything without it), THEN the v0->tree adapter (which unblocks the "v0-via-adapter" baseline — the literal test of the core hypothesis: does v0+resolver beat neural+resolver on clean inputs?), THEN the router, THEN the arbiter. Do you agree with eval-first, and is the v0->tree adapter the right second step (it's on the critical path for every v0-involving baseline)?

Q7. Auto-labeling loop — make it concrete and non-circular. Plan: take a large UNLABELED US address corpus, run BOTH parsers, resolve BOTH, label each input "v0-wins/neural-wins/tie" by resolver-score delta, train the LR quality scorer on lexical features -> that label. The risk you flagged: resolver score isn't calibrated and both-garbage cases produce noise labels. Deeper risk: if the scorer is trained on resolver-score-delta, isn't it just learning to predict the arbiter — so why not always run the arbiter? My answer: the scorer is a CHEAP approximation of the arbiter so we DON'T pay 2x parse on clean/noisy-confident traffic. Is that the right framing, and how do I keep the auto-labels honest (drop low-confidence/both-garbage rows? require a minimum resolver-score margin to count as a "win"?)?

Q8. The "prove it first" MVP. I want the smallest slice that VALIDATES the thesis before building the router. Candidate: eval harness + neural-only baseline + v0-via-adapter baseline + resolver-arbiter(full, no band) + oracle. If arbiter and oracle materially beat both single-parser baselines (esp. arbiter >> neural-only on the clean subset and >> v0 on the perturbed subset), the routing thesis is proven and the cheap router is worth building; if arbiter ≈ neural-only, routing is a dead end and I should pivot to coverage. Is this the right kill/continue gate, and what delta (in Place-Match Acc@1) would you call "material"?

## Turn 2 (response)
## Follow‑up Answers – Hardening the Mailwoman Plan

You’ve designed a sharp, data‑driven approach. Now let’s pressure‑test the corners that could weaken the whole stack before you commit to an execution plan. The four questions are addressed in turn.

---

### Q5. OpenAddresses Eval Track – Worth the Ingestion Cost?

**Short answer:** Yes, it’s worth including a **minimum viable slice** of OpenAddresses (OA) as a secondary eval track, but it should **not** block the first milestone. The WOF‑bootstrap + golden (Pelias‑derived) combo gives you a trustworthy enough signal to prove the routing thesis and tune thresholds; OA adds an independent, real‑world coordinate‑error metric that strengthens external credibility and guards against accidental overfitting to the WOF gazetteer.

**Why OA is valuable (despite being admin‑resolved):**
- It tests the resolver with *real address strings* that contain the noise, aliases, and omissions of actual field data, not just synthetic perturbations.
- The great‑circle error from the resolved admin centroid to the OA lat/lon is an **absolute, gazetteer‑independent** measure of geocoding utility. Even a perfect WOF match can have a large coordinate error if the locality centroid is far from the actual point (e.g., rural routes).
- It gives you a direct, defensible number for stakeholders: “For X% of real US addresses, we return a place within Y km of the true location.”

**Why it’s not strictly necessary for the first gate:**
- The routing decision depends on parser accuracy under different input types. WOF‑bootstrap perturbed variants already cover the clean/noisy axis rigorously, and the golden set guards against regression on Pelias‑compatible inputs.
- The resolver’s ranking quality can be measured on WOF‑bootstrap by its ability to disambiguate Springfield‑style conflicts. OA mainly exercises the resolver’s coverage of real address strings, which is correlated.

**Minimum viable slice (if you decide to include it):**
- **Size:** ~10 000 points, sampled to cover:
  - 5–8 diverse US states (urban‑heavy like NY/CA, suburban, rural like IA/WY)
  - Balance of house‑number‑full and street‑only records
  - Exclude PO‑box and rural‑route heavy sources unless you specifically want to measure the coverage gap (then keep a small sample)
- **Filtering:** Keep only records where a locality and postcode are present (to match the resolver’s admin‑level output). Optionally propagate locality from USPS city if the OA schema has it.
- **Cost:** A one‑time ingestion script that normalises the schema, strips duplicates, and samples. No ongoing maintenance required before the kill/continue gate.

**Integration:** Run this slice through the neural‑only and v0‑via‑adapter baselines, then the arbiter. Report the median and p90 great‑circle error. If the arbiter reduces p90 error by >20% relative to neural‑only on the clean subset, you have a strong double‑barrelled story (WOF place match **and** coordinate error). If not, it doesn’t undercut the routing thesis, but it tempers the “real‑world impact” claim.

**Conclusion:** Start with WOF‑bootstrap + golden for the kill/continue gate; build the OA track as a parallel effort that can be dropped if it slips schedule. Its presence will force you to think about coordinate calibration and will make the eventual public launch numbers far more convincing.

---

### Q6. Build Order – Eval First, Then Adapter, Then Router/Arbiter

Your ordering is correct, and I’d reinforce it with a concrete sequence that minimises the risk of building the wrong thing.

1. **Eval harness + data generation**  
   - WOF‑bootstrap sets (canonical + perturbed)  
   - Golden set (for regression)  
   - (Optional) OA mini‑slice  
   - Metrics implementation: hierarchy‑tolerant Place‑Match Acc@1, coordinate error, component F1, resolver success rate

2. **v0‑to‑tree adapter**  
   - This is on the critical path for **every** v0‑involving baseline. Without it, you cannot even measure whether v0+resolver beats neural+resolver on clean inputs.  
   - The adapter itself is low‑risk: a deterministic `PARENT_OF` mapping combined with a simple tree builder. It’s the right second step because it unblocks all subsequent experiments.

3. **Single‑parser baselines (neural‑only, v0‑via‑adapter)**  
   - Run them on the eval suite. This gives you the numbers that define the baseline window: clean inputs favour v0, noisy favour neural.  
   - This is the moment of truth for the adapter’s correctness—if v0 resolves worse than random, debug the adapter immediately.

4. **Resolver‑arbiter (offline, dual‑parse + dual‑resolve)**  
   - Implement as a script, **not yet in the online pipeline**. It gives you the **oracle** and **arbiter** baselines.  
   - This directly answers the kill/continue question (Q8) without building any routing logic.

5. **Kill/continue decision**  
   - If the arbiter materially beats both single‑parser baselines (see Q8), proceed.  
   - If not, pivot to coverage or fusion; do not build the router.

6. **Lexical quality scorer**  
   - Train on auto‑labelled data (using the arbiter as the label source). Integrate as a lightweight pre‑parse classifier.

7. **Online router with confidence bands**  
   - Integrate the scorer, set initial thresholds from the eval suite, and add the fallback to dual‑parse + arbiter for the ambiguous band.

8. **Online arbiter integration**  
   - Wire the dual‑parse + resolve flow only for the ambiguous band, reusing the resolver service that already exists.

9. **Tune, monitor, A/B test**

**Critical principle:** Every step produces an evaluable artefact. You never invest in routing heuristics until the raw potential is proven. The adapter, while simple, is the linchpin that unlocks the v0 leg of the system; it’s worth building a clean, well‑tested version early.

---

### Q7. Auto‑Labeling Loop – Concrete, Non‑Circular, Honest

You have nailed the framing: the lexical scorer is a **cheap approximation of the arbiter**, so we pay 2× parse only on ambiguous cases. The auto‑labeling loop must produce reliable labels for the scorer without falling into the “why not always arbiter?” trap. Here’s how to make it concrete and honest.

**Step 1: Calibrate the resolver’s confidence score**  
On the WOF‑bootstrap eval set (where you know the correct WOF ID), compute:
- The resolver confidence score distribution for correct vs. incorrect matches.
- A **minimum threshold** below which the result is almost certainly wrong (e.g., the 5th percentile of scores for correct matches).
- A **win margin** (delta) that corresponds to a meaningful improvement in accuracy. For example, when the winning parse’s score exceeds the loser’s by >5% of the score range, the winner is correct in ≥90% of cases. This threshold can be tuned on the eval set where you have oracle “v0 wins / neural wins” labels.

**Step 2: Source unlabelled US address strings**  
Use a corpus that reflects real‑world input quality but is **not** synthetic:
- A sample of from an existing geocoder query log (if available and privacy‑safe).
- Alternatively, the **OpenAddresses** dataset itself (the full set, not just the mini‑slice), filtered to contain a locality and postcode. This gives you millions of real, messy address strings without additional collection.

**Step 3: Generate labels for each input**  
For each string in the corpus, run:
- v0‑parse → v0‑to‑tree adapter → resolve → score_v0
- neural‑parse → resolve → score_neural

Then:
- **Drop both‑garbage rows:** If score_v0 < min_threshold AND score_neural < min_threshold, discard. These are unresolvable inputs that would only introduce noise.
- **Drop marginal‑win rows:** If |score_v0 – score_neural| < win_margin, discard. These are ambiguous cases where even the arbiter isn’t confident; they belong in the online ambiguous band anyway.
- **Label:** v0_wins = 1 if score_v0 > score_neural + margin, else neural_wins = 1. (Ties already dropped.)

**Step 4: Train the lexical quality scorer**  
Extract the pre‑parse features (comma count, casing ratio, gazetteer token hits, digit patterns, etc.) and train a binary classifier (logistic regression) to predict v0_wins. This model will output a probability p(v0_wins). The ambiguous band can be defined as, for example, 0.3 < p < 0.7.

**Why this is not circular and still valuable:**
- The scorer learns to mimic the arbiter’s preference, but on features that are 100× cheaper to compute than a neural parse + resolve. That’s exactly the point.
- On high‑confidence inputs (p > 0.8 or p < 0.2), the scorer’s decision is extremely likely to agree with the arbiter, so we save the cost of running both parsers.
- The ambiguous band is the only place we pay the full cost, and it’s a small fraction of traffic.

**Maintaining honesty over time:**
- Periodically re‑run the arbiter on a holdout sample of recent traffic and re‑calibrate the win margin / min threshold.
- Monitor the scorer’s decisions in production: log a random 1% of requests with both parses and compare scorer’s routing to arbiter’s preference. If the agreement rate decays, retrain.
- This closes the loop without requiring manual labels and ensures the scorer tracks the arbiter’s notion of quality.

**One additional safeguard:** Add a lightweight gazetteer‑coverage check. If the input contains a locality name that is **not** present in the WOF FST, it’s almost certainly a case where neither parser will resolve well; you can route directly to neural (which is more robust) without dual‑parse. This reduces false v0‑wins in the training set.

---

### Q8. “Prove It First” MVP – Kill/Continue Gate & Materiality

Your proposed MVP is exactly the right scope:  
**Eval harness + neural‑only + v0‑via‑adapter + resolver‑arbiter (full) + oracle**  
It tests the core hypothesis without building any routing infrastructure.

**The kill/continue question:**  
If the arbiter does **not** materially outperform the single‑parser baselines (especially neural‑only on clean inputs), then even a perfect router cannot create value. The gate should be:

> **On the WOF‑bootstrap eval set (canonical + perturbed combined), the arbiter improves hierarchy‑tolerant Place‑Match Acc@1 by at least 5 percentage points over the better of the two single‑parser baselines on each subset (clean vs perturbed), AND does not degrade coordinate error more than 10% on either subset.**

More operationally:
- **Clean subset:** Arbiter Acc@1 > neural‑only Acc@1 + 5 pp (we expect v0 to be strong here, but neural might be decent; arbiter should pick v0’s wins and beat neural cleanly).
- **Perturbed subset:** Arbiter Acc@1 ≥ neural‑only Acc@1 – 1 pp (i.e., arbiter must not be harmfully worse; neural already dominates noise, arbiter might occasionally pick v0 by mistake and degrade, so the bound is tight).
- **Overall (weighted equally):** Arbiter > neural‑only by at least 3 pp, demonstrating that the ability to choose the better parse lifts the whole stack.
- **Oracle:** Should be above arbiter, revealing the room left for a better router.

If these thresholds are met, routing is worth building. If the arbiter only beats neural by 1–2 pp, the added operational complexity (maintaining two parsers, maintaining the adapter, building the scorer) is hard to justify for a marginal gain. You would then pivot to improving the neural model or expanding coverage, and keep v0 as a fallback for niche cases but not integrate it deeply.

**What if the arbiter loses on the perturbed subset?**  
If arbiter’s accuracy drops more than 2 pp below neural‑only on noisy inputs, that indicates the resolver’s scoring function is biased toward v0’s cleaner but sometimes wrong parses. Before abandoning routing, investigate whether the arbiter’s confidence thresholds can be tuned to default to neural on low‑quality inputs. If a simple rule like “if neural’s parse produces a valid tree with all components filled, prefer it when the quality score is below X” fixes the regression, routing may still be salvageable. The kill decision should be based on the **tuned** arbiter, not the naive max‑score rule.

**Material delta in practise:**
- A 5 pp increase in Place‑Match Acc@1 on clean US addresses translates to millions of correctly geocoded shipments or service queries, and directly maps to the operator’s goal of “leaving no performance on the table.”
- Even a 3 pp overall gain, with a clear per‑subset story, is a strong business case. The operator can see that their clean, canonical‑looking inputs (which usually come from high‑value integrated systems) now receive the same high accuracy that v0 demonstrated in the capability map.

**Additional kill criteria to consider:**
- If the v0‑via‑adapter baseline on clean inputs is **not** actually better than neural‑only (i.e., the capability map doesn’t transfer because the adapter destroys information or the resolver doesn’t exploit v0’s flat structure), then routing is dead before the arbiter is even tried. You would catch this at step 3 of the build order, before investing in the arbiter.
- Therefore, a preliminary gate: v0‑via‑adapter must achieve >85% of v0’s stand‑alone component accuracy on canonical inputs in the golden set (since v0’s strength is parsing, not resolving). If it does, proceed to arbiter; if not, fix the adapter or abandon the v0 integration.

**Summary:**  
The MVP is the right kill/continue gate. The bar should be a **5 pp improvement on clean inputs** and **no significant regression on noisy inputs**, using hierarchy‑tolerant Place‑Match Acc@1. If the arbiter clears that bar, proceed with confidence; if not, reallocate effort to the neural parser’s coverage gaps or to post‑processing the resolver’s ranking.
