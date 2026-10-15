I'm trying to make sense of a blocker but can't quite figure out how to proceed. Can you review this write up and let me know what you think? I think what embarrasses me is that this is an encoder, the smallest sort of ML task. I think I'm not understanding what's going on because I don't know enough about machine learning 101

# The segmentation thesis: a review

**For a reader who knows postal addresses cold and ML in general terms.** Everything here is measured
on the shipped model (v264 / v6.3.0) or the probe checkpoint (v301), on committed fixtures, with the
commands in the repo. Where we were wrong, the correction is in place rather than in a footnote.

---

## 1. The problem, stated precisely

Mailwoman is a ~29M-param encoder that emits per-subword BIO tags over 33 address tags, decoded by
Viterbi under a structural BIO mask. Downstream, a WOF-backed resolver geocodes the parse tree.

**Classification is solved. Segmentation is not.** On the rescued v1 parity corpus (321 hand-written
fixtures, 20 countries, deliberately fragment-heavy):

| tag          | shipped v264 | floor    |
| ------------ | ------------ | -------- |
| postcode     | 0.986        | 0.97     |
| house_number | 0.808        | 0.97     |
| **street**   | **0.573**    | **0.90** |

Coarse geography is ~99%. The model assigns the right class to each component. It fails to place
**the boundary where one component ends and the next begins**.

The archetype, on the shipped model:

```
Korunní 810, Praha   →   street="Korunní 8"   house_number="10"
```

It knows there's a street and a number. It puts the boundary inside the number.

## 2. The thesis

Under flat BIO, the output **factorizes** into T per-token decisions. The encoder is shared, so the
tokens are not independent in any representational sense — but the loss and the decode treat them as
separable. "These five subwords are one street" is therefore not a decision the model is ever scored
on. It is an emergent property of five separate votes that happen to agree. There is no object anywhere
in the objective or the decode that represents _the solution_.

This has two consequences we can point at in the data:

**(a) The objective scores tokens only.** `Rue` is deterministic in French. It can only be a street
prefix, governing what follows. A transformer's attention can propagate that implication forward.
The representation is not the constraint, and we should not claim it is. The gap is narrower and
more fixable: **the objective and the decode score each token separately and never score
segment-level coherence, and the prior on bare toponyms is wrong.** Cross-entropy over T positions
pays for each token being individually right. A reading that is locally reasonable everywhere and
incoherent as a whole incurs zero extra loss. So:

```
Avenue Victor Hugo   →  street ✓          ("Victor Hugo" is a person)
Rue Montmartre       →  locality ✗        (Montmartre IS a Paris district)
Rue de Rome          →  locality ✗        (Rome IS a city)
12 Rue Montmartre    →  hn / prefix / street ✓
```

The prefix isn't the variable — **toponym identity is**, and a house number is what breaks the tie.
"Montmartre" votes locality. The training distribution taught it to do that: bare street fragments
are rare in the corpus and bare localities are common, so the prior is doing exactly its job
and the job is wrong. The objective assigns the same cost to propagating the prefix's implication
as to ignoring it.

**(b) No structural coherence.** The decode accepts output that matches no address shape. Compare
the rules-based ancestor (Pelias-style scheme matching), which always emits a structurally coherent
solution — because a scheme is a claim about the _whole input at once_. The two systems fail from
opposite defects. Rules fail on messy input because the hypothesis space is **closed**: a finite
scheme list drops any off-template input. Flat BIO fails on clean input because the space is **too
open**: T independent votes, with the shape unconstrained.

**The proposal:** score whole _segmentations_ — a semi-Markov CRF over spans, with a **segment-level**
transition grammar. Same idea as scheme matching, except the scores are learned and the hypothesis
space is every segmentation rather than a hand-written list. And : **k-best output**, because
the useful artifact is a ranked list of readings rather than one answer.

This project abandoned a **token-level** CRF at v0.5.0
(bf16 NaN, `crf_loss_weight=0.0` ever since). That scar was treated as "CRF diverged" for ~200 model
versions. It doesn't transfer: at subword granularity, transitions are noise — _"must `1` follow `▁8`"_
is not grammar. At segment granularity (5–8 segments rather than 40 subwords), "house_number is adjacent to
street", "one postcode per reading" is well-posed. Same table, right altitude.

---

## 3. The address taxonomy that predicts failure

This is the part a rules person will recognise, and the part that surprised us. Measured on a
purpose-built 63-fixture Paris corpus (famous streets, homonyms, esoterica, elisions, date-names, plus
contextful controls), shipped v264:

| class                  | example                           | v264 street exact |
| ---------------------- | --------------------------------- | ----------------- |
| contextful/multi-class | `12 Rue du Chat-qui-Pêche, Paris` | **9/10**          |
| contextful/homonym     | `8 Rue de Rome, Paris`            | **6/6**           |
| bare/esoteric          | `Rue de la Grande-Truanderie`     | 7/10              |
| bare/elision           | `Rue de l'Hôtel-de-Ville`         | 3/6               |
| bare/homonym           | `Rue de Rome`                     | 4/12              |
| **bare/famous**        | `Avenue des Champs-Élysées`       | **3/15**          |
| date-name              | `Avenue du 11-Novembre-1918`      | 1/4               |

**The exotic morphology is not the problem.** Apostrophe elisions, hyphenated compounds, date-based
names, accented capitals — `12 Rue du Chat-qui-Pêche, Paris` parses correctly. Meanwhile
`Avenue des Champs-Élysées` returns the **empty string**.

**The variable is the house number.** On the general corpus, the same split:

|                         | fail rate                        |
| ----------------------- | -------------------------------- |
| no house number present | **66%** (80/122 street failures) |
| leading US-style number | 22%                              |

And a result that killed a planned tokenizer change: **multi-digit numbers are the _best_-performing
digit form (17% fail)** vs short-digit 29% and alphanumeric (`16a`) 73%. We had a digit-atomicity
splice queued on the theory that per-digit tokenization (`810` → `▁8 1 0`) caused the boundary bleed.
The partition counter-evidenced it before it cost a training run.

### The two failure mechanisms

Of 30 unfixed Paris cases, 26 have no digit at all, and they split directly:

**17 — the model calls the whole string a `locality`.** It emits that tag with confidence.
`Avenue des Champs-Élysées → locality`. This is a **recall/polarity** failure.

**13 — the span truncates, always at a French function word or a digit:**

```
Rue des Rosiers            → "Rue des"
Rue de l'Hôtel-de-Ville    → "Rue de"
Avenue du 11-Novembre-1918 → "Avenue du 11"
Rue d'Amsterdam            → "d'Amsterdam"      (dropped the affix!)
```

The through-line is French street morphology: `<affix> <particle> <name>`. **Spans die at the
particle.** Which is telling, because `street_prefix_particle` is already a tag in our schema — the
schema anticipated the structure. Flat BIO can't execute it.

---

## 4. What we built and what it measured

### Phase 1 — the span head

Additive-biaffine span scorer over start/end projections → per-type scores for every span ≤8 tokens,
a segment transition table, and an fp32 semi-Markov CRF loss co-trained alongside the untouched BIO
head. Both DP routines (log-partition, Viterbi) were verified against **brute-force enumeration of
every valid segmentation**. A DP that is subtly wrong still trains, toward the wrong target.

**The pre-registered check:** `seg@1 > token@1`, plus a secondary read (oracle@10 must rise).

**First probe failed and we nearly called it falsified.** Loss went 26.4 → 17.77 and was still
falling. The decode emitted a random type per token, and seg@1 = 0.004. The diagnostic that saved it: _"is the loss even
decreasing?"_ It was, and nowhere near converged (raw span NLL ~35 where a converged semi-CRF is O(1)).

**The cause was ours.** We inherited `lr: 1e-5` from a recipe that _fine-tunes existing weights_. The
span head is randomly initialized. A fresh head cannot train at a pretrained encoder's fine-tuning LR.
One variable — a param-group LR of 1e-3 for the head — and loss converged to 1.37 (raw NLL ~2.7).

### The headline, and its correction

We first reported **+7.9pp**. That was measured in a Python harness that feeds none of the production
soft channels (postcode anchor / gazetteer / country lexicon). With channels fed:

| triaged parity (n=267) | v264, summed-BIO spans | **v301, learned spans** |
| ---------------------- | ---------------------- | ----------------------- |
| token@1                | 0.573                  | 0.5693                  |
| **seg@1**              | 0.453                  | **0.5768**              |
| oracle@5               | 0.663                  | **0.7228**              |
| oracle@10              | 0.749                  | **0.7753**              |

**The margin over the token decode is +0.75pp — two fixtures, inside noise.** Much of the original
+7.9pp was the BIO head's _starvation_ rather than the span head's strength. Feed the channels and BIO
recovers most of it.

What survives, and matters:

1. **The trained scorer beats the summed-BIO stand-in by +12.4pp** (0.453 → 0.5768), same instrument.
   That was the actual falsifier, and it holds by 12.4pp.
2. **The secondary read passed**: oracle@10 rose 0.749 → 0.775, oracle@5 0.663 → 0.723. The _list_
   improved — the config had pre-registered "if seg@1 crosses but oracle@10 is flat, the
   scorer reshuffled without learning."
3. **On the target class it is not close.** Paris fixture: `token@1` byte-identical to v264 (33/63),
   `seg@1` **48/63 — +23.8pp**, oracle@5 **0.905**.

And the archetype is fixed:

```
Korunní 810, Praha  →  Korunni:street  810:house_number  Praha:locality
```

### Phases 2–3 — export and decode

The export adds `span_scores` as an ONNX output. A runtime fetches it by its output key, so a
runtime that ignores it prunes the branch. The transition table ships as a JSON sidecar with the
segment-type axis **in the file** rather than hardcoded. The k-best decode is in JS, brute-force
verified, and shared by node and browser.

Costs, measured on the runtime that ships (`onnxruntime-web` WASM EP rather than the node bench):

|                                             |                       |
| ------------------------------------------- | --------------------- |
| ONNX↔torch span parity                      | worst 7.3e-06         |
| int8 size                                   | +0.22 MB (**+0.57%**) |
| browser latency, spans read every inference | +0.08 ms (**+0.5%**)  |

### Phase 4a — the rerank, and where the thesis broke

The plan: the resolver arbitrates the k-best list. _A rank-2 parse that resolves to a real place beats
a rank-1 that resolves to a country centroid._ It is evidence-based without hand-weights, explicitly avoiding
the Pelias failure mode (see §6).

**Result: null, with a mechanism.**

|          | parity (267)    | Paris (63)      |
| -------- | --------------- | --------------- |
| seg@1    | 0.5768          | 0.7619          |
| rerank@1 | 0.5768 (**+0**) | 0.7460 (**−1**) |

**The circularity:** the arc targets bare fragments. A bare fragment has **no house number** (the
address-point tier is keyed by number) and **no locality** (the street-centroid tier needs a locality to
scope by). So every hypothesis resolves to the same admin centroid. Evidence rate — fixtures where
_any_ hypothesis reaches street tier:

| US   | FR   | NL   | DE   | ZZ/NZ/AU/NO/PT/PL/RO |
| ---- | ---- | ---- | ---- | -------------------- |
| 0.01 | 0.03 | 0.22 | 0.23 | **0.00**             |

On the Paris fixture with the FR street-centroid DB loaded: **314 hypothesis geocodes → admin 314,
street 1.**

It is not a noisy signal. **There is no signal.** Resolution evidence can only adjudicate addresses
that are already resolvable — which are the ones the parse mostly gets right anyway.

---

## 5. Where it stands

**The floors are unmoved.** street 0.90 vs seg@1 0.577. **oracle@5 is 0.723** — so even a _perfect_
reranker lands short of the check. The decode cannot clear it without another change. This is the fact that
phase momentum most wants to obscure.

**What's proven:** a trained span scorer beats the BIO stand-in by +12.4pp, fixes the
boundary class including the archetype, adds +24pp on bare fragments, and costs the browser +0.5%
latency / +0.6% download.

**What's disproven:** _"the arbiter is the resolver."_ For the class that needs arbitration, the
resolver is blind.

**What's unresolved:** ~15pp of measured headroom (oracle@5 0.723 vs shipped 0.573) sitting in the
list with no arbiter to collect it.

### The direction we think is right, and haven't tested

The resolver answers _"where is this?"_ The question a bare fragment needs is **"is this a street name
at all?"** — an existence check against the BAN/gazetteer **name index**. It requires neither a locality nor a
house number, so it sidesteps the circularity entirely. `ban/street-centroids-fr.db` contains every
French street name. A check of whether `Rue de Rome` is in it is a lexicon lookup rather than a geocode.

Two signals have already failed. The plausibility veto was inert. Resolution specificity scored −16,
because preferring "finer" among `country` / `region` / `locality` _rewards the locality-reading failure mode_. A
third goes to review before it goes to a branch.

### The other half, still unbuilt

The span head does **not** fix the 17 locality-refusals. That was never its job. That's
`option C`: feed the kind-classifier posterior as a soft channel (established plumbing — the postcode
anchor and country lexicon work this way) plus a recall-weighted street loss. The kind posterior is a
synthetic anchor standing in for the missing house number.

Explicitly rejected, on review: a hard "must emit street" decode mask (kind-classifier errors become
hallucinations — and the uncertain cases _are_ the failing ones), and injecting a forced hypothesis
into the k-best list (its score comes from a different normalization, and incomparable scores in one
list repeat the Pelias-blend antipattern at small scale).

---

## 6. Context: what the dictionary approach costs

We read Pelias's vendored dictionary layer (`parser/resources/pelias/dictionaries`). **94 of 276
non-comment lines are deletions.** A `!token` line removes a token that libpostal classifies as a
street type. The comments state each reason:

```
# this Italian contracted form of Androna causes issues in English   → !and     (Trieste loses)
# conflicts with US state abbreviation                                → !ca      (Spain loses to California)
# Causes a bunch of issues with Spanish addresses ("Calle" ...)       → !alle    (Norway loses to Spain)
# 18 person county in texas                                           → !art     (Art, TX pop. 18, loses)
# remove any localities which share a name with a US state            → !alabama
#!new york                                                            ← commented out. They tried.
#!washington                                                          ← same.
```

Nearly every override is a rare-but-real meaning colliding with a common one — `ca`, `ch`, `ga`, `ma`,
`in`, `a`, `art` — resolved by **globally deleting the rare side**. This is _correct EV given a
dictionary_. "art" appears in millions of queries, and Art, Texas has eighteen residents. The
maintainers chose correctly for a dictionary. The cost is that each deletion is irreversible and
context-free, and a lookup cannot be otherwise because it has no context to consult.

The commented-out `#!new york` / `#!washington` is the tell: a blunt global rule, then a hand-kept
exception list for the entries too famous to lose.

**Our receipts, including the one that hurts:**

```
Art, TX               → {region:TX, locality:Art}      ✓
Alabama, NY           → {region:NY, locality:Alabama}  ✓
Calle Mayor 5, Madrid → street:"Calle Mayor"           ✓
Italy, TX             → {country:Italy, region:TX}     ✗   ← we fail this too
```

4/5, and the miss is the instructive part. `Italy, TX` is the exact row Pelias hand-deleted. We get it
wrong differently. The claim is narrower than a win: **holding an ambiguity isn't resolving it.** Our
error is _recoverable_. `Italy, TX` is in the country-channel homograph class. Its knob is
`country_ambiguous_scale`. v263 set that knob hard and over-suppressed. v264 relaxed it to 0.5 _and
measured_ the result: homograph F1 82.6 → 85.1, with no trade-off. Pelias's equivalent knob is a line you delete.

---

## 7. Methodology, since two results nearly went out wrong

Both near-misses had the same signature: **a number that couldn't reproduce something already known.**

- Phase 1's check reported `token@1` 0.348 against a known 0.573. Cause: a Python harness feeding no
  soft channels, plus a bug welding words together (`▁5|th|▁|Ave` → `"5thAve"` — it dropped the
  `O`-labeled separator). Nearly published as an architecture verdict.
- Phase 4a's first rerank showed one signal inert and another −16. Cause: the harness resolver had no
  street extracts and reached street tier **0 times in 267 fixtures**. Nearly published as _"resolution
  evidence can't work."_

Both times the tell was there before the conclusion. Check the instrument before the hypothesis.

We also found `from_pretrained()` never passed `map_location`, so a
GPU-trained checkpoint couldn't load on a CPU box **at all** — that had been silently blocking every
local grading run.

## 8. What we'd want a reviewer to push on

> **Answered.** All four went to review and came back adjudicated — see
> [`2026-07-16-span-head-arc-review-follow-up.md`](./2026-07-16-span-head-arc-review-follow-up.md)
> for the verdicts and the converged plan. Kept here as asked rather than as open.

1. **Is +0.75pp at rank-1 enough to justify the decode?** We say no, and that the case is the list.
   Is that motivated reasoning about a phase we already built?
2. **Is the name-existence check the right third signal**, or is the rerank a dead end and option C
   the whole answer?
3. **The floor is 0.90 and oracle@5 is 0.723.** Is the parse-tag floor even the right check, or is a
   coordinate-acceptability check the right one? (A prior study found the neural parse is 98.6%
   within 1 km of the rules parse where the street is correct, with a hard tail on exactly the
   bare-fragment class.)
4. **Is a 63-fixture Paris corpus enough** to make per-class claims, or are we reading noise?
