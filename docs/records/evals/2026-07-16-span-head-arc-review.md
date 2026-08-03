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

Coarse geography is ~99%. The model knows _what things are_. What it cannot reliably do is say **where
one thing ends and the next begins**.

The archetype, on the shipped model:

```
Korunní 810, Praha   →   street="Korunní 8"   house_number="10"
```

It knows there's a street and a number. It puts the boundary inside the number.

## 2. The thesis

Under flat BIO, the output **factorizes** into T per-token decisions. The encoder is shared, so the
tokens are not independent in any representational sense — but the loss and the decode treat them as
separable. "These five subwords are ONE street" is therefore not a decision the model is ever scored
on; it's an emergent property of five separate votes that happen to agree. There is no object anywhere
in the objective or the decode that represents _the solution_.

This has two consequences we can point at in the data:

**(a) Nothing rewards governance.** `Rue` is deterministic in French — it can only be a street prefix,
governing what follows. A transformer's attention is perfectly capable of carrying that implication
forward; the representation is not the constraint, and we should not claim it is. What's missing is
narrower and more fixable: **nothing in the objective or the decode rewards segment-level coherence,
and the prior on bare toponyms is wrong.** Cross-entropy over T positions pays for each token being
individually right. A reading that is locally reasonable everywhere and incoherent as a whole costs
the loss nothing. So:

```
Avenue Victor Hugo   →  street ✓          ("Victor Hugo" is a person)
Rue Montmartre       →  locality ✗        (Montmartre IS a Paris district)
Rue de Rome          →  locality ✗        (Rome IS a city)
12 Rue Montmartre    →  hn / prefix / street ✓
```

The prefix isn't the variable — **toponym identity is**, and a house number is what breaks the tie.
"Montmartre" votes locality, which is what the training distribution taught it to do: bare street
fragments are rare in the corpus and bare localities are not, so the prior is doing exactly its job
and the job is wrong. Nothing in the objective makes propagating the prefix's implication cheaper
than ignoring it.

**(b) No structural coherence.** Nothing enforces that the output looks like _any_ address. Compare
the rules-based ancestor (Pelias-style scheme matching), which always emits a structurally coherent
solution — because a scheme is a claim about the _whole input at once_. The two systems fail from
opposite defects: rules fail on messy input because the hypothesis space is **closed** (a finite
scheme list; anything off-template falls through); flat BIO fails on clean input because the space is
**too open** (T independent votes; nothing constrains the shape).

**The proposal:** score whole _segmentations_ — a semi-Markov CRF over spans, with a **segment-level**
transition grammar. Same idea as scheme matching, except the scores are learned and the hypothesis
space is every segmentation rather than a hand-written list. And critically: **k-best output**, because
the useful artifact is a ranked list of readings, not one answer.

Worth noting for anyone who's been here before: this project abandoned a **token-level** CRF at v0.5.0
(bf16 NaN, `crf_loss_weight=0.0` ever since). That scar was treated as "CRF diverged" for ~200 model
versions. It doesn't transfer: at subword granularity, transitions are noise — _"must `1` follow `▁8`"_
is not grammar. At segment granularity (5–8 segments, not 40 subwords), "house_number is adjacent to
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

Of 30 unfixed Paris cases, 26 have no digit at all, and they split cleanly:

**17 — the model calls the whole string a `locality`.** Not silence; _confidence_.
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
schema anticipated the structure; flat BIO can't execute it.

---

## 4. What we built and what it measured

### Phase 1 — the span head

Additive-biaffine span scorer over start/end projections → per-type scores for every span ≤8 tokens;
segment transition table; fp32 semi-Markov CRF loss co-trained alongside the untouched BIO head.
Both DP routines (log-partition, Viterbi) verified against **brute-force enumeration of every valid
segmentation** — a DP that's subtly wrong still trains, it just trains toward the wrong thing.

**The pre-registered gate:** `seg@1 > token@1`, plus a secondary read (oracle@10 must rise).

**First probe failed and we nearly called it falsified.** Loss 26.4 → 17.77, still falling; decode
emitted a random type per token; seg@1 = 0.004. The diagnostic that saved it: _"is the loss even
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
+7.9pp was the BIO head's _starvation_, not the span head's strength. Feed the channels and BIO
recovers most of it.

What survives, and matters:

1. **The trained scorer beats the summed-BIO stand-in by +12.4pp** (0.453 → 0.5768), same instrument.
   That was the actual falsifier and it holds decisively.
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

`span_scores` as a named ONNX output (fetched by name, so a runtime that ignores it prunes the
branch); the transition table as a JSON sidecar with the segment-type axis **in the file** (never
hardcoded); k-best decode in JS, brute-force verified, shared by node and browser.

Costs, measured on the runtime that ships (`onnxruntime-web` WASM EP, not the node bench):

|                                             |                       |
| ------------------------------------------- | --------------------- |
| ONNX↔torch span parity                      | worst 7.3e-06         |
| int8 size                                   | +0.22 MB (**+0.57%**) |
| browser latency, spans read every inference | +0.08 ms (**+0.5%**)  |

### Phase 4a — the rerank, and where the thesis broke

The plan: the resolver arbitrates the k-best list. _A rank-2 parse that resolves to a real place beats
a rank-1 that resolves to a country centroid._ Evidence-based, no hand-weights — explicitly avoiding
the Pelias failure mode (see §6).

**Result: null, with a mechanism.**

|          | parity (267)    | Paris (63)      |
| -------- | --------------- | --------------- |
| seg@1    | 0.5768          | 0.7619          |
| rerank@1 | 0.5768 (**+0**) | 0.7460 (**−1**) |

**The circularity:** the arc targets bare fragments. A bare fragment has **no house number** (the
address-point tier is keyed by number) and **no locality** (the street-centroid tier has nothing to
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
reranker lands short of the gate. The decode was never going to clear it alone. This is the fact that
phase momentum most wants to obscure.

**What's proven:** a trained span scorer beats the BIO stand-in decisively (+12.4pp), fixes the
boundary class including the archetype, adds +24pp on bare fragments, and costs the browser +0.5%
latency / +0.6% download.

**What's disproven:** _"the arbiter is the resolver."_ For the class that needs arbitration, the
resolver is blind.

**What's unresolved:** ~15pp of measured headroom (oracle@5 0.723 vs shipped 0.573) sitting in the
list with no arbiter to collect it.

### The direction we think is right, and haven't tested

The resolver answers _"where is this?"_ The question a bare fragment needs is **"is this a street name
at all?"** — an existence check against the BAN/gazetteer **name index**. No locality, no house number
required, so it sidesteps the circularity entirely. `ban/street-centroids-fr.db` contains every French
street name; asking whether `Rue de Rome` is in it is a lexicon lookup, not a geocode.

Two signals have already failed (plausibility veto: inert; resolution specificity: −16, because
preferring "finer" among `country` / `region` / `locality` _rewards the locality-reading failure mode_). A
third goes to review before it goes to a branch.

### The other half nobody's built yet

The span head provably does **not** fix the 17 locality-refusals — that was never its job. That's
`option C`: feed the kind-classifier posterior as a soft channel (established plumbing — the postcode
anchor and country lexicon work this way) plus a recall-weighted street loss. The kind posterior is a
synthetic anchor standing in for the missing house number.

Explicitly rejected, on review: a hard "must emit street" decode mask (kind-classifier errors become
hallucinations — and the uncertain cases _are_ the failing ones), and injecting a forced hypothesis
into the k-best list (its score comes from a different normalization; incomparable scores in one list
is the Pelias-blend antipattern in miniature).

---

## 6. Context: what the dictionary approach costs

We read Pelias's vendored dictionary layer (`parser/resources/pelias/dictionaries`). **94 of 276
non-comment lines are deletions** — `!token` meaning "libpostal says this is a street type; we say
no." The comments are the stories:

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
dictionary_: "art" appears in millions of queries; Art, Texas has eighteen residents. Nobody was
careless. It becomes scar tissue only in one narrow sense: it's irreversible and context-free, and it
can never be otherwise, because a lookup has no context to consult.

The commented-out `#!new york` / `#!washington` is the tell: a blunt global rule, then a hand-kept
exception list for the entries too famous to lose.

**Our receipts, including the one that hurts:**

```
Art, TX               → {region:TX, locality:Art}      ✓
Alabama, NY           → {region:NY, locality:Alabama}  ✓
Calle Mayor 5, Madrid → street:"Calle Mayor"           ✓
Italy, TX             → {country:Italy, region:TX}     ✗   ← we fail this too
```

4/5, and the miss is the instructive part. `Italy, TX` is the exact row Pelias hand-deleted; we get it
wrong differently. So the claim isn't "we win" — it's narrower: **holding an ambiguity isn't resolving
it.** We get to be wrong _recoverably_ — `Italy, TX` is the country-channel homograph class, whose
knob is `country_ambiguous_scale`, which v263 set hard, over-suppressed, and v264 relaxed to 0.5 _and
measured_ (homograph F1 82.6 → 85.1, no trade). Pelias's equivalent knob is a line you delete.

---

## 7. Methodology, since two results nearly went out wrong

Both near-misses had the same signature: **a number that couldn't reproduce something already known.**

- Phase 1's gate reported `token@1` 0.348 against a known 0.573. Cause: a Python harness feeding no
  soft channels, plus a bug welding words together (`▁5|th|▁|Ave` → `"5thAve"` — it dropped the
  `O`-labelled separator). Nearly published as an architecture verdict.
- Phase 4a's first rerank showed one signal inert and another −16. Cause: the harness resolver had no
  street shards and reached street tier **0 times in 267 fixtures**. Nearly published as _"resolution
  evidence can't work."_

Both times the tell was there before the conclusion. Check the instrument before the hypothesis.

Also worth flagging for a reviewer: we found `from_pretrained()` never passed `map_location`, so a
GPU-trained checkpoint couldn't load on a CPU box **at all** — that had been silently blocking every
local grading run.

## 8. What we'd want a reviewer to push on

> **Answered.** All four went to review and came back adjudicated — see
> [`2026-07-16-span-head-arc-review-follow-up.md`](./2026-07-16-span-head-arc-review-follow-up.md)
> for the verdicts and the converged plan. Kept here as asked, not as open.

1. **Is +0.75pp at rank-1 enough to justify the decode?** We say no, and that the case is the list.
   Is that motivated reasoning about a phase we already built?
2. **Is the name-existence check the right third signal**, or is the rerank a dead end and option C
   the whole answer?
3. **The floor is 0.90 and oracle@5 is 0.723.** Is the parse-tag floor even the right gate, or is a
   coordinate-acceptability gate the right one? (A prior study found the neural parse is 98.6%
   within 1 km of the rules parse where the street is correct, with a hard tail on exactly the
   bare-fragment class.)
4. **Is a 63-fixture Paris corpus enough** to make per-class claims, or are we reading noise?
