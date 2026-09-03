# Faithful per-decision attribution for a small BIO tagger, and confidence implementation for error-shape diagnosis

Research memo, 2026-08-16. Question: can mailwoman's ~tens-of-millions-param, 4–6-layer encoder BIO
tagger be made to explain its per-decision reasoning _faithfully_ — in particular to flag "decision
made with evidence channels silent" and to say _where_ a labeling decision formed — and what
confidence implementation fits classifying failures into a discrete, human-triaged, slowly-evolving
diagnosis vocabulary?

Grounding read: `docs/records/site-2026-08/concepts/what-mailwoman-is.mdx` (calibrated,
retrieval-augmented sequence labeler; channels are soft features, never overrides) and
`packages/neural/lib/soft-features.ts` (the channel choreography: anchor, gazetteer, country,
street-type channels, each `features[][]` + `confidence[]`, fed alongside `input_ids`; the
ProductionScorer already asserts _which_ channels were fed). The Weimar case in this memo's terms:
every channel row was zero, the token-embedding pathway alone produced the (correct) labels, and
the resolver then chose Weimar, Texas — a _cross-boundary contradiction_ the current implementation has
no way to notice.

Verification key: **[S]** = verified via web search this session; **[M]** = from memory (high
confidence unless hedged). Anything 2025-or-newer is flagged inline.

---

## 1. Faithful attribution for small taggers

### 1.1 Activation patching / causal tracing

**What it is.** Run the model twice — once on the real input, once on a corrupted or counterfactual
input — and copy ("patch") a chosen internal activation from one run into the other; the change in
output logits is the _causal_ contribution of that activation. Introduced at scale as "causal
tracing" in ROME — Meng et al. 2022, _Locating and Editing Factual Associations in GPT_ [S] — which
found mid-layer MLPs at the subject token mediate factual recall. Path patching refines this to
specific component→component paths (Wang et al. 2022, _Interpretability in the Wild_ — the IOI
circuit [M]; Goldowsky-Dill et al. 2023, _Localizing Model Behavior with Path Patching_ [M]).
Causal scrubbing (Chan et al. 2022, Redwood Research [M]) and ACDC (Conmy et al. 2023, _Towards
Automated Circuit Discovery_ [M]) automate hypothesis testing and circuit search.

**Cost/feasibility at our scale.** This is where the tagger's size flips the economics. At LLM
scale, a patching sweep is linear in components and "can be prohibitively expensive, involving
millions to billions of forward passes," which is why DeepMind built AtP* — a gradient
approximation running in O(1) passes (Kramár et al. 2024, _AtP\*: An efficient and scalable method
for localizing LLM behaviour to components_ [S]; note also _When Attribution Patching Lies_ (2026)
[S] on AtP's false negatives and a second-order correction). For a 6-layer encoder with ~8 heads +
1 MLP per layer over ~32 SentencePiece pieces, an **exhaustive** sweep is ≈ 6 × 9 × 32 ≈ 1,700
patch sites per input — a couple of GPU batches, well under a second per case, seconds on ONNX CPU.
Exhaustive _path_ patching over all component pairs is a few hundred thousand forwards — minutes.
What is a research program at LLM scale is a nightly board metric here: a full causal trace of
every row of the 558-row dev board is a lunch-break job on the lab GPU. We don't even need AtP
approximations, though they come free (one backward pass) since we own the PyTorch side.

**What it buys.** The literal answer to "WHERE did this labeling decision form": layer/position/
component coordinates for each B/I decision, and — by patching the _channel input rows_
specifically — a causal (not correlational) measure of whether the decision used the evidence
channels at all. Two probe directions matter: (a) zero the channels (a no-op when they were already
zero, as in Weimar), and (b) **counterfactual injection** — feed the channel values the retrieval
side _would_ have produced had it known the place, and measure the logit/label delta. Direction (b)
is the honest "evidence sensitivity" measurement.

**Pitfalls.** Choice of corruption distribution changes conclusions (Gaussian-noise vs.
counterfactual-token patching disagree; discussed across the patching literature [M]). Patching
finds _sufficient mediators_, not unique stories; backup/redundant circuits can hide behind each
other (the hydra effect [M]). For BIO tagging, patch metrics should be per-token label logit
deltas, not sequence loss, or Viterbi coupling smears the localization.

**Weimar verdict.** A patch sweep would have localized the locality/region decisions to the
embedding→mid-layer-MLP pathway on the "Weimar"/"Thüringen" pieces with zero causal contribution
from any channel row, and counterfactual channel injection would have shown the parse is
channel-insensitive here — i.e., a mechanical demonstration that this was a grammar-only decision.

### 1.2 Integrated gradients, occlusion, and simpler attribution

**What they are.** Integrated Gradients (Sundararajan, Taly & Yan 2017, _Axiomatic Attribution for
Deep Networks_ [M]) integrates input gradients along a baseline→input path; occlusion (Zeiler &
Fergus 2014 [M]) ablates input pieces and measures output change; DeepLIFT (Shrikumar et al. 2017
[M]) and SHAP (Lundberg & Lee 2017 [M]) are relatives. All are input-attribution: they answer
"which input features mattered," not "which internal computation."

**Cost/feasibility.** Trivial. IG is ~50 forwards+backwards per token decision on the PyTorch side;
occlusion of _channels_ (not tokens) is one extra ONNX forward per channel group and works in
production, browser included. Because our channels are _named, human-meaningful input columns_, IG
over the channel inputs is far more meaningful than IG over token embeddings is for an LLM — the
concept bottleneck is at the input, so input attribution _is_ concept attribution.

**What it buys.** The cheapest deployable "evidence-silent" detector: per decision, the share of
attribution mass on channel inputs vs. token embeddings. Report it per parse; alarm when a
high-confidence parse carries ~zero channel share. Note the degenerate case: when channels are
all-zero, occlusion is a no-op and IG attribution to them is trivially ~0 — the flag can be
computed _without any attribution at all_ as an input predicate ("all channel confidences zero"),
which soft-features.ts can emit today. Attribution earns its keep on the _mixed_ cases where
channels fired but may have been ignored.

**Pitfalls.** IG's baseline choice matters (zero-embedding baselines are out-of-manifold [M]);
gradient attributions can fail sanity checks (Adebayo et al. 2018, _Sanity Checks for Saliency
Maps_ [M]); none of these are causal guarantees — for required claims, confirm with patching.

**Weimar verdict.** IG would have put essentially all attribution mass on the raw token embeddings
and none on the (zero) channels — the exact "confident parse, silent evidence" signature — but the
same flag falls out of a one-line input predicate without computing a single gradient.

### 1.3 Why attention weights are not the explanation

Jain & Wallace 2019, _Attention is not Explanation_ [S]: attention distributions correlate poorly
with gradient-based importance and admit adversarial alternative distributions yielding the same
predictions. Wiegreffe & Pinter 2019, _Attention is not not Explanation_ [S]: the rebuttal —
existence of an alternative distribution constructed ad hoc doesn't prove unfaithfulness; tests
must be model-consistent — but even the rebuttal claims only that attention _may sometimes_ carry
explanatory signal, not that it's faithful. Serrano & Smith 2019, _Is Attention Interpretable?_
[M], and the survey Bibal et al. 2022, _Is Attention Explanation? An Introduction to the Debate_
(ACL) [S] round out the picture. Practical rule for us: attention maps are a debugging _display_,
never a faithfulness _claim_; anything we assert about "the model looked at X" must come from
patching or channel interventions. **Weimar verdict:** some head would show "Thüringen" attending
to "Weimar" and the comma, and the debate literature says that licenses no conclusion about why
the labels came out right.

### 1.4 Cheap extras that are only possible because the model is tiny

- **Logit lens / tuned lens** (nostalgebraist 2020; Belrose et al. 2023 [M]): project each layer's
  residual stream through the classifier head; for a 6-layer encoder this yields a per-token
  "decision depth" — the layer at which the BIO label crystallizes — for the cost of five extra
  matmuls. Early crystallization + high confidence + silent channels is a distinctive signature.
- **Linear probes** (Alain & Bengio 2016 [M]): train a logistic probe on the residual stream for
  "country of this address" — recovering the model's _implicit_ country belief even when the
  country channel was silent. One matmul at inference. In the Weimar case the probe would have
  read "DE-ish" off the hidden states while the resolver committed to US — a contradiction
  detector spanning the model/resolver boundary, which is where the actual failure lived.
- **Exact interchange interventions as _input_ experiments**: because the interpretable concepts
  are input columns, swapping channel values between paired inputs is a causal experiment needing
  no model surgery at all — a luxury LLM interpretability does not have.

---

## 2. Sparse autoencoders (SAEs)

**What they are.** Dictionary-learning decompositions of activations into overcomplete sparse
"monosemantic" features: Anthropic's line — Bricken et al. 2023, _Towards Monosemanticity:
Decomposing Language Models With Dictionary Learning_ [S]; Templeton et al. 2024, _Scaling
Monosemanticity_ [M] — plus architecture successors: TopK SAEs (Gao et al. 2024, _Scaling and
evaluating sparse autoencoders_, OpenAI [S]), Gated and JumpReLU SAEs (Rajamanoharan et al. 2024,
DeepMind [M]), Gemma Scope's released SAE suites (Lieberum et al. 2024 [M]), crosscoders (Anthropic
2024 [M]). The 2025 successor to raw SAEs for _circuit-level_ explanation is transcoders +
attribution graphs: Anthropic 2025, _Circuit Tracing: Revealing Computational Graphs in Language
Models_ and _On the Biology of a Large Language Model_ [S], with the open-source `circuit-tracer`
library (Gemma-2-2B / Llama-3.2-1B / Qwen3-4B) [S].

**The 2025 correction — important.** The field partially walked back SAE enthusiasm in 2025 [S]:

- DeepMind's mech-interp team, March 2025: _Negative Results for Sparse Autoencoders On Downstream
  Tasks and Deprioritising SAE Research_ — SAEs underperformed simple linear probes for the
  downstream probing tasks they tried.
- Kantamneni et al. 2025, _Are Sparse Autoencoders Useful? A Case Study in Sparse Probing_ [S] —
  same conclusion from a careful case study.
- Heap et al. 2025: SAEs trained on _randomly initialized_ models also yield "interpretable"
  features — some SAE interpretability doesn't reflect model properties [S].
- Paulo & Belrose 2025: feature instability across seeds [S]; _Sparse Autoencoders Do Not Find
  Canonical Units of Analysis_ (2025) [S, title from aggregate — moderate confidence on authors].
- Related-but-different: OpenAI Nov 2025, _Weight-sparse transformers have interpretable circuits_
  (arXiv 2511.13653) + the Dec 2025 `circuit-sparsity` release [S] — train the _model_ sparse
  instead of decomposing a dense one; circuits ~16× smaller at matched loss. Interesting for us
  only as a _retraining_ option (we own training), not as post-hoc analysis.

**Cost/feasibility at our scale.** Training cost is a non-issue: d_model of a few hundred, a
dictionary of 4–16k features, activations harvested over the corpus — an SAE per layer trains in
well under an hour on the lab GPU; the full stack in an evening, Modal not required. The real cost
is the _human_ loop: naming and validating thousands of features, building tooling to browse them,
and re-doing it every retrain (mailwoman retrains constantly — the ~1-hour iteration loop is the
project's core asset — and SAE features do not transfer across retrains; seed-instability results
above make this worse).

**What it buys vs. a tagger's alternatives — and why it's overkill here.** For an LLM, SAEs exist
because you _don't know what the concepts are_. Our situation is inverted: the interesting concepts
(postcode-ness, gazetteer membership, country, street-type) are already named input columns, and
the label vocabulary is 33 BIO tags. For "does the model internally represent German-place
morphology?" a supervised linear probe answers in minutes and — per the 2025 results — likely
better. The one genuine SAE use-case for us: an _exploratory inventory_ of what grammar features a
trained checkpoint contains that we did NOT think to probe for (e.g., a "Latin-script diacritic +
Germanic suffix" feature), run once as a weekend experiment, treated as hypothesis generation whose
outputs get confirmed by probes/patching. Sparse feature circuits (Marks et al. 2024 [M]) would be
the follow-on if that inventory proves rich.

**Pitfalls.** Everything in the 2025 correction above, plus: reconstruction error means SAE-based
stories are about a _approximation_ of the model; features found on our small corpus may be
dataset artifacts ("fake features" — FaithfulSAE 2025 [S]).

**Weimar verdict.** An SAE would likely have surfaced a "German place morphology" feature (umlaut,
-ingen/-üringen pieces, Länder names) firing hard on "Thüringen" — evidence the model carries an
internal country detector the resolver never consulted — but a supervised country probe finds the
same fact for a thousandth of the effort.

---

## 3. Concept bottlenecks and right-for-the-right-reasons

**The framing that matters:** mailwoman's evidence channels are already a _partial, leaky concept
bottleneck at the input_ — interpretable concept columns the model may consult, with a raw
token-embedding bypass around them. That is a deliberate architecture choice (the concepts doc's
"features, never overrides"; the override failure mode is documented project history). So the
relevant literature is not "how to build a bottleneck" but "how to _measure and steer_ reliance on
one that leaks."

**Concept bottleneck models.** Koh et al. 2020, _Concept Bottleneck Models_ (ICML) [S/M]: predict
interpretable concepts, then predict the label _only_ from concepts; supports test-time concept
intervention. The leakage literature is the required part for us: Mahinpei et al. 2021,
_Promises and Pitfalls of Black-Box Concept Learning Models_ [M]; Margeloiu et al. 2021, _Do
Concept Bottleneck Models Learn as Intended?_ [M]; Havasi et al. 2022, _Addressing Leakage in
Concept Bottleneck Models_ (NeurIPS) [S]; Shin et al. 2023, _A Closer Look at the Intervention
Procedure of Concept Bottleneck Models_ (ICML) [S]; _Avoiding Leakage Poisoning: Concept
Interventions Under Distribution Shifts_ (2025) [S]; a 2025 survey of risks/limitations of
concept-based models and even a 2026 _In Defense of Information Leakage in Concept-based Models_
[S] — the field now recognizes leakage as a tradeoff, not a sin. Hard bottlenecks buy intervention
validity and pay in accuracy exactly on inputs the concept vocabulary doesn't cover — which for us
is every place the gazetteer doesn't know. **Weimar is the proof we want the leak**: a hard
bottleneck (parse only from channels) would have had literally zero input and been forced to
abstain or emit garbage; the bypass produced the correct parse. The failure was downstream — so
the right implementation _flags_ bypass decisions rather than preventing them.

**Right for the right reasons.** Ross, Hughes & Doshi-Velez 2017, _Right for the Right Reasons:
Training Differentiable Models by Constraining their Explanations_ (IJCAI) [S]: penalize input
gradients on features the model _shouldn't_ use (or reward gradients on ones it should). Directly
implementable in corpus-python as a `∂logits/∂channel` regularizer — but note the sign: our
problem is under-reliance on channels only when channels are _present and correct_; when they're
silent, token-embedding reliance is desired behavior. A blanket penalty is the wrong change.

**Interchange-intervention training / causal alignment — the strongest fit.** Geiger et al. 2022,
_Inducing Causal Structure for Interpretable Neural Networks_ (IIT, ICML) [S]; Geiger et al. 2024,
_Finding Alignments Between Interpretable Causal Variables and Distributed Neural Representations_
(DAS) [S]; Boundless DAS (Wu et al. 2023) [S]. These _train_ the model so that named causal
variables (e.g., "country", "this-span-is-a-locality") live in designated activation subspaces and
respond correctly to interventions. Since we own the PyTorch training loop and a retrain costs
~1 hour, IIT is actually affordable here in a way it is not for LLM labs: add an interchange loss
tying a small residual subspace to the country variable, and the model acquires a _guaranteed
read-out port_ — per-decision explanation becomes reading a register instead of running forensics.

**Measuring reliance (auditing, no retraining).** The clean instrument our architecture enables:
paired inputs where ONLY channels differ (same token string, different simulated "world") — the
output delta is the causal channel-reliance, measurable per tag, per locale, per checkpoint, as a
standing board metric. This is an input-level interchange intervention; no model surgery. Related
framings: permutation-style model reliance (Fisher, Rudin & Dominici 2019, _All Models are Wrong,
but Many are Useful_, JMLR [M]); shortcut-learning auditing (Geirhos et al. 2020, _Shortcut
Learning in Deep Neural Networks_, Nature MI [M]); rationale-faithfulness metrics —
comprehensiveness/sufficiency from ERASER (DeYoung et al. 2020 [S]; rationale extraction lineage
Lei et al. 2016, _Rationalizing Neural Predictions_ [S]) transfer directly: "sufficiency of the
channels" = performance parsing from channels alone; "comprehensiveness" = performance drop with
channels ablated. For validating whatever attribution method we adopt, ground-truth-known
evaluation exists: Tracr (Lindner et al. 2023 [S]) and InterpBench (Gupta et al. 2024, semi-
synthetic transformers with known circuits [S]; the MIB benchmark, 2025 [S, hedged]) — and our own
"known-operations" analog is even better: we can _construct_ corpus items where the correct answer
is derivable only from a channel, so any faithful method must attribute to it.

**Pitfalls.** IIT constrains capacity and could cost tier-1 accuracy — it lands under the D-rule
(no default-on mechanism with a known tier-1 regression), so it's a gated experiment, not a free
win. Reliance metrics averaged over a board hide per-locale collapse; compute them per tier.
Leakage literature warns that intervention on a leaky bottleneck can _hurt_ (leakage poisoning,
2025 [S]) — relevant if we ever add "correct the channel and re-run" tooling.

**Weimar verdict.** A hard concept bottleneck would have abstained (no concept evidence at all) and
been _wrong to do so_ at parse level; reliance auditing would have scored the case "0% channel
reliance, 100% grammar" — precisely the flag wanted — and an IIT-trained country register would
have read "DE" while the resolver said "US", turning the actual failure into a machine-checkable
contradiction.

---

## 4. Confidence implementation for error-shape classification

Setting: a classifier (or human-in-the-loop triage assistant) that maps a failure case to a
discrete _diagnosis_ — an error shape like "evidence-silent parse", "resolver country flip",
"postcode anchor override" — calibrated against a human-triaged ledger, with abstention, where the
diagnosis vocabulary itself evolves as new shapes are discovered.

**Calibration.** Guo et al. 2017, _On Calibration of Modern Neural Networks_ (ICML) [S]:
temperature scaling — one parameter fit on held-out data — fixes most overconfidence; ECE is the
standard metric (use adaptive binning — Nixon et al. 2019, _Measuring Calibration in Deep
Learning_ [M] — because a triage ledger is small and imbalanced). Temperature scaling never changes
the argmax; when per-class miscalibration differs (it will, with rare diagnoses), Dirichlet
calibration (Kull et al. 2019, _Beyond temperature scaling_, NeurIPS) [S] is the multiclass
upgrade. Minderer et al. 2021, _Revisiting the Calibration of Modern Neural Networks_ [S] for the
modern picture. Mailwoman already runs isotonic calibration (Zadrozny & Elkan 2002 [M]) on parse
confidences — the same discipline applies to the diagnosis head, but _fit on the ledger_, and
refit on a rolling window because triage standards drift.

**Selective prediction (abstention).** The classical stack: Chow 1970 (reject option) [M];
Geifman & El-Yaniv 2017, _Selective Classification for Deep Neural Networks_ [M] — pick an
operating point on the risk–coverage curve; SelectiveNet 2019 [M] trains the abstainer jointly.
When the abstention target is a human triager with limited attention, the right framing is
learning-to-defer: Mozannar & Sontag 2020, _Consistent Estimators for Learning to Defer to an
Expert_ (ICML) [S]; multi-expert/two-stage variants Mao et al. 2023 [S]; cost-sensitive deferral
under workload constraints 2024 [S].

**Conformal prediction — the recommended backbone.** Split (inductive) conformal (Vovk et al.,
_Algorithmic Learning in a Random World_, 2005 [M]; Angelopoulos & Bates 2021, _A Gentle
Introduction to Conformal Prediction_ [M]) turns any score into prediction _sets_ with finite-
sample coverage guarantees, using only a calibration split of the ledger. For diagnosis, sets are
the honest output shape: "this failure is `{resolver-country-flip, evidence-silent}` at 90%" is more
useful to a triager than a single guess, and **abstention falls out naturally** (defer when the set
is large; alarm when the set is empty at the working level). Two specifics for our shape:

- **Class-conditional (Mondrian) coverage.** Marginal conformal under-covers rare classes —
  measured collapses to near-0% minority coverage in a 2026 multi-domain benchmark, with Mondrian
  restoring it (+61.7pp average) [S]; see also _Class-Conditional Conformal Prediction with Many
  Classes_ (Ding et al. 2023) [S]. Diagnosis ledgers are exactly this: a few common shapes, a long
  tail. Mondrian's per-class calibration also has a governance bonus below. Rule of thumb: ~20–40
  triaged rows per class before that class's guarantee means anything (coverage resolution is
  1/(n_class+1)).
- **Sequence-labeling precedent.** Conformal has been run on NER/extraction: Fisch et al. 2022
  (multilabel NER sets with false-positive limits) [S]; conformal for key-information extraction
  (IJDAR 2026) [S]; survey: Campos et al. 2024, _Conformal Prediction for NLP_ (TACL) [S].

**The evolving vocabulary — no off-the-shelf standard; here is the assembled practice.** I found no
literature that directly treats "calibrated posterior over a _changing_ discrete diagnosis
vocabulary" as a solved problem [S — searched; absence noted, not proven]. The assembled recipe
from adjacent literatures:

1. **An explicit `novel/other` outcome** backed by conformal novelty p-values — test "does this
   case conform to _any_ known class" (conformal novelty detection with FDR control: AdaDetect,
   Marandon et al. [S]; _Conformal Inference for Open-Set and Imbalanced Classification_, 2025
   [S]); lineage: open-world recognition, Bendale & Boult 2015 (CVPR) [S] / OpenMax 2016 [M].
   A case that conforms to no known shape is the trigger to _mint a class_, not a classification.
2. **Mondrian per-class calibration makes vocabulary growth cheap**: adding diagnosis class K+1
   requires only K+1's own calibration rows; existing classes' guarantees are untouched. Marginal
   calibration would need a global refit and silently shifts everyone's coverage.
3. **Exchangeability honesty**: a ledger triaged over months by a human whose taxonomy is drifting
   is not exchangeable; use weighted/rolling-window conformal (_Conformal Prediction Beyond
   Exchangeability_, Barber et al. 2023 [M]; label-shift variant Podkopaev & Ramdas 2021 [M]) and
   version the vocabulary the way the eval ledger already versions scores.
4. Alternative posterior implementation — evidential deep learning (Sensoy et al. 2018, _Evidential
   Deep Learning to Quantify Classification Uncertainty_, NeurIPS [S]; survey Ulmer et al.,
   _Prior and Posterior Networks_ [S]) gives a Dirichlet over classes whose total evidence is an
   abstention signal in one head. Tempting, but its epistemic-uncertainty claims have known
   theoretical soft spots [M — critique line c. 2022–2024, moderate confidence], and it needs the
   classifier retrained under a special loss; conformal wraps _any_ scorer, ledger-sized data is
   its native regime, and its guarantee survives the classifier being a heuristic. Recommendation:
   conformal + Dirichlet/temperature calibration; skip EDL.

**Weimar verdict.** Parse-level calibration would rightly _not_ have flagged it (the parse was
correct and deserved its confidence); the alarm belongs in the diagnosis layer — "evidence-silent
parse + resolver crossed country" as a ledger class — where a Mondrian-conformal classifier would
have put the case in that class's prediction set with a per-class coverage guarantee, or, before
that class existed, emitted a novelty p-value telling the triager to mint it.

---

## 5. Weimar case, one line per method (consolidated)

| Method                       | What it would have said about "Weimar, Thüringen"                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input predicate (no interp)  | "All channel confidences zero, parse confidence high" — the flag, computable today in `soft-features.ts` output.                                     |
| Occlusion / channel ablation | Nothing — ablating already-zero channels is a no-op; must run the counterfactual direction (inject plausible channel values) instead.                |
| Integrated gradients         | ~All attribution mass on token embeddings, ~none on channels — automatic evidence-silent alarm, at gradient cost.                                    |
| Attention inspection         | A head attends Thüringen→Weimar/comma; per Jain & Wallace vs. Wiegreffe & Pinter, this licenses no faithfulness claim.                               |
| Activation patching          | Locality/region decisions localize to the embedding→mid-layer pathway with zero causal channel contribution — grammar-only decision, proven.         |
| Path patching / circuits     | Names the specific embedding→MLP→classifier path (a "German morphology" subcircuit) carrying the region label.                                       |
| Logit lens / decision depth  | Labels crystallize in early layers — easy-grammar signature; early + confident + channel-silent = the alarm triple.                                  |
| Linear country probe         | Hidden states read "DE" while the resolver chose US — the cross-boundary contradiction that _was_ the actual failure.                                |
| SAE dictionary               | Would likely surface a German-place-morphology feature firing on "Thüringen" — same fact as the probe, at ~1000× the effort.                         |
| Hard concept bottleneck      | Would have been forced to abstain (zero concept input) — and been wrong, since the parse was right; shows why the bypass is a feature at parse time. |
| RRR gradient penalty         | Would push reliance toward channels — the wrong change here; the model's grammar-only decision was correct.                                          |
| IIT/DAS country register     | A trained country subspace would have output "DE" as a first-class readable value for the resolver to check against.                                 |
| Calibration (parse level)    | No flag — correctly confident; calibration is not an error-shape detector.                                                                           |
| Mondrian conformal diagnosis | Classifies the case into "evidence-silent + resolver country flip" with per-class coverage, or emits a novelty p-value before that class exists.     |

---

## 6. Feasibility summary and recommended order (one lab GPU + Modal bursts)

1. **Ship the predicate** (days, CPU): "channels silent + confidence high" flag from the existing
   `SoftFeatures` confidences, surfaced through the scorer/ProductionScorer contract and into the
   resolver as a caution bit. Zero model work; would have flagged Weimar.
2. **Country probe + decision depth** (a weekend, lab GPU): linear probe on the residual stream
   for implied country; logit-lens depth per token. Both are matmul-cheap at inference and give
   the model/resolver contradiction detector. Requires exporting hidden states from the ONNX
   graph (or a second output head at export time — we own the export).
3. **Channel-reliance board metric** (a week): paired-input interchange interventions (same
   string, injected vs. silent channels) over the dev board; per-tag, per-locale reliance shares;
   ERASER-style sufficiency/comprehensiveness of channels as two numbers per checkpoint. This is
   the standing "feature-reliance audit" and catches reliance drift across retrains.
4. **Patching forensics tool** (a week, lab GPU): exhaustive activation-patch sweep as an on-demand
   `mwdev`-style tool for any board row — the "WHERE did this decision form" answer. Exhaustive is
   affordable _only because_ the model is 4–6 layers; no AtP approximation needed.
5. **Optional, gated experiments**: IIT country register (one ~1-hour retrain + D-rule gate); a
   single exploratory SAE run for feature inventory (evening of GPU) — deprioritized per the 2025
   negative-results literature, probes first.
6. **Diagnosis confidence**: Mondrian split-conformal over the triage ledger with a conformal-
   novelty `other` bucket, temperature/Dirichlet-calibrated scores underneath, rolling-window
   recalibration, risk–coverage curve to pick the abstention operating point. Ledger discipline:
   ~20–40 rows per class before trusting that class's guarantee; version the vocabulary.

**Verification status**: all bracketed [S] items were confirmed by web search this session
(2026-08); [M] items are from memory — high confidence on the canonical pre-2024 papers (IG,
occlusion, IOI, causal scrubbing, ACDC, Geifman–El-Yaniv, Barber et al. 2023), moderate confidence
where hedged inline (EDL critiques, Matryoshka-era SAE variants, MIB authorship). Post-2025
developments flagged: DeepMind SAE deprioritization (2025-03), sparse-probing negative results
(2025), Anthropic attribution graphs + circuit-tracer (2025), OpenAI weight-sparse circuits
(2025-11/12), AtP second-order correction (2026), cost-sensitive conformal abstention benchmark
(2026), conformal KIE (2026).
