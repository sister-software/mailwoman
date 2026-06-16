# Coarse-placer as a soft country prior — wiring spec (#244)

_Wire the OA-broadened coarse-placer (the promoted #244 model) into the resolver as a **soft country
prior** — informs ranking, never filters — at an abstention threshold of **~0.9**. Default-off, byte-stable,
PR-and-flag. The verdict that motivates the soft-signal-at-0.9 choice:
`docs/articles/evals/2026-06-14-coarse-placer-oa-breadth.md`._

## Goal & non-goals

- **Goal:** when the geocoder resolves an address, let the coarse-placer's whole-string country guess
  **bias** country-level disambiguation (region + locality namesake collisions), the same way a postcode
  pins it today — so `Plauen, …` (DE) stops resolving to a US/IT namesake, and an off-map address stops
  getting pinned to a wrong in-map country.
- **Non-goal:** it is **not** a gate. It never filters candidates, never abstains the pipeline, never
  overrides an explicit `--default-country`/locale or a stronger signal. A wrong guess costs a little
  ranking weight, never a dropped or wrong-filtered result. (This is why ~0.9 is safe — see Threshold.)

## The mechanism already exists — reuse the #369 anchor re-rank

The postcode-anchor re-rank (#369, `core/resolver/resolve.ts`) is exactly the soft-prior machinery:

```
anchorPosterior: Record<country, prob>     // a country→probability map
re-rank: sort by exactMatch (PRIMARY, tier-safe) THEN score + anchorWeight * posterior[candidate.country]
       → byte-identical when anchorPosterior is undefined; applied to region + locality only
```

So the coarse-placer becomes **another `anchorPosterior` source** — no new ranking code. `CoarsePlacer.predict(text)` returns `{ country, confidence, abstained }`; we map a non-abstained prediction to a one-hot-ish posterior `{ [country]: confidence }` (or a softmax over the top-k) and feed it through the existing re-rank.

## Composition with the postcode anchor (precedence)

Both emit country posteriors; they must not double-count.

- **Postcode anchor present → it wins.** A postcode pins the country far more reliably than a whole-string
  guess. The coarse-placer posterior is **not applied** when the #369 postcode posterior exists.
- **No postcode anchor → coarse-placer fills the gap**, at a **lower `anchorWeight`** than the postcode
  anchor's 2.0 (proposed **1.0**) — it's a broader, softer signal, so it should blend more gently with
  `score`.
- **Coarse-placer says `OTHER` (off-map)** → emit **no in-map posterior** (equivalently a flat/empty map):
  don't boost any of the 11; let the unconstrained ranking handle it. That's the graceful off-map path.

## Where it runs

- **New opt-in pipeline stage `placeCountry`** (early — Stage ~2, on the normalized string), mirroring how
  `classifier`/`resolver`/`fst` are optional stages in `createRuntimePipeline`. When provided, the
  pipeline computes the posterior once and threads it into `resolveOpts.anchorPosterior`/`anchorWeight`
  (deferring to a postcode posterior per the precedence rule above).
- **`geocode-core`** wires the same: a `CoarsePlacer` dep (optional), posterior fed into the resolve opts.
- **Off by default → byte-identical.** Like `resolve`/`fst`, absent the stage the pipeline is unchanged.
  PR-and-flag; promotion to default is a separate, evidence-gated step.

## Threshold ~0.9 (and why the soft framing earns it)

`abstainBelow = 0.9` (vs the code default 0.5). Below 0.9 → `abstained` → **no posterior** → byte-stable.

The measured tradeoff (OA-retrained model, `docs/articles/evals/2026-06-14-coarse-placer-oa-breadth.md`):

| abstain | in-map accuracy | off-map heldout caught |
| ------: | --------------: | ---------------------: |
|    0.50 |           95.1% |                  66.1% |
|    0.85 |           91.8% |                  82.5% |
|    0.95 |           87.8% |                  87.6% |

The in-map "cost" of a high threshold is a **false abstention** — but in the soft design a false abstention
just means "no country hint this time," which degrades gracefully (the resolver ranks unconstrained, still
correct). The harmful error is the opposite: a **confident wrong placement** on an off-map address (→ wrong
country search). So the asymmetry favors a high threshold, and **~0.9** sits where off-map catch is high
(~85%) while the only thing we "lose" on in-map is some boosts we'd have applied — not correctness. (A
_hard_-gate design would force ~0.85 to keep in-map routing >90%; the soft design removes that pressure.)

## Validation — grade the ASSEMBLED pipeline, not the model

Per the reconcile-retirement lesson (grade the pipeline against truth, never a component's intrinsic F1):

- **Primary metric:** on a country-disambiguation eval (ambiguous namesakes — Berlin DE/US, Plauen, bare
  region abbreviations "VT"/"ME" — plus off-map addresses), measure the geocoder's **right-country rate**
  WITH vs WITHOUT the coarse-placer posterior. Must improve the ambiguous/off-map cases at **no in-map
  regression** (reuse the honest-eval harness + the #369 namesake set).
- **Byte-stability check:** with the stage off, output is byte-identical (CI-assertable).
- Gate promotion-to-default on a measured net-positive here, exactly as #584/#590 were gated.

## Prerequisite — the model must ship

The coarse-placer int8 model (0.79 MB) currently lives only on `/mnt/playpen`; nothing ships it. Wiring it
for installed consumers needs it packaged. **Recommended:** commit the int8 artifact under `core/data/` and
add it to `@mailwoman/core`'s `files` (it already ships ~9 MB of dictionaries; +0.79 MB is negligible), with
`CoarsePlacer.fromArtifactDir` resolving the bundled path by default + an env/opt override. (Alternative: a
dedicated weights package — heavier process for a tiny artifact.) **This is gated by the v4.8.1
clean-install smoke test** — the new artifact must resolve from a fresh `npm install`.

## Use-case impact (the three modes)

- **CLI** (`mailwoman geocode/parse`): opt-in flag (`--place-country` / on when the model is present). The
  placer is always-resident + microsecond-cheap, so no startup cost concern.
- **Library** (`import "mailwoman"` batch geocoding): a `CoarsePlacer` dep on `createRuntimePipeline` /
  `geocodeAddress`; callers opt in. Most valuable here (record-matching/normalization at scale benefits
  from correct country disambiguation).
- **Client / Docusaurus (static assets)**: the model is a 0.79 MB int8 linear classifier with a pure
  char-ngram featurizer — **it can run in-browser**, but that's a **follow-on web build** (a `@mailwoman/…`
  browser export + bundling the artifact). Not in this spec's scope; flagged as the natural next step so the
  demo's "it all runs client-side" story eventually includes country routing.

## Risks & the open lever

- **Double-counting with the postcode anchor** → the precedence rule (postcode wins; coarse-placer fills).
- **Model-not-shipped** → the packaging prerequisite above; must pass `ci:smoke`.
- **The linear ceiling** → the threshold can't push _both_ axes past ~90 (curves cross at ~88/88). The
  follow-on (separate milestone) is an **open-set / novelty method** (Mahalanobis on the in-map manifold,
  or a "not-any-of-11" head) that moves the whole frontier out — at which point the threshold relaxes and a
  default-on (even gate) integration becomes defensible.

## Phasing

1. **M1 (this spec):** ship the int8 model in `@mailwoman/core`; add the opt-in `placeCountry` stage feeding
   `anchorPosterior` (precedence-aware), threshold 0.9; the assembled-pipeline country-disambiguation eval;
   byte-stability + `ci:smoke` checks. PR-and-flag, default-off.
2. **M2:** open-set/novelty method to lift the 90/90 ceiling → consider default-on.
3. **M3:** browser build for the client/demo path.
