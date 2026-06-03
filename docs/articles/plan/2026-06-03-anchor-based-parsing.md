# Anchor-based parsing & multi-locale architecture — direction (2026-06-03)

**Direction D.** Treat the highest-information tokens in an address — the postcode first, then
distinctive streets and landmarks — as *first-class structured anchors* that condition (or bypass) the
neural parser, instead of flattening them into just-another-BIO-tag. Pair that with a single
self-conditioned model per **script** shard, a tiny always-resident coarse placer for graceful
abstention, and a strict soft-prior discipline so anchors never launder errors. DeepSeek-signed across
two consults (German conditioning: `.agents/skills/deepseek-consult/session-notes-2026-06-02-german-conditioning.md`;
resolver routing: `.agents/skills/deepseek-consult/session-notes-2026-05-30-resolver.md`).

## Why now

The v0.8.0 German order-shard experiment ([postmortem](../evals/2026-06-02-night-4-postmortem.md))
taught two things at once. The order *is* learnable cheaply — a 5,000-row shard roughly doubled German
street and house-number F1. But the continue-train re-triggered the Saint-Albans span-fragmentation
bug at end-of-string: the model bled the postcode span into the adjacent city (`München` → `chen`,
`Berlin` → absorbed into the postcode run), which collapsed locality/postcode and dragged the resolver
down with it. The collapse is **emission-level** — raw per-token argmax already fragments, so no
decoder span-merge or CRF-transition table can repair it (both are downstream of emissions, and the
error is *cross-tag*: a city's lead piece leaking into `postcode`, not a same-tag split).

The mechanism reframes the whole roadmap. A postcode is not an arbitrary number — it is a hierarchical
geo-encoding (US ZIP runs NE→W by first digit; a UK postcode plus a house number nearly identifies a
building; German PLZ and French codes are zone-hierarchical). It is the single most information-dense
token in an address, and we were asking a sequence labeler to find it *and* to know where it stops,
in the same pass, with nothing telling it the postcode is a different kind of thing from the city it
sits beside. That framing is the bug. Lift the postcode out with a dedicated high-precision extractor,
resolve it, and feed it back as a conditioning anchor, and the model never gets the chance to make the
cross-tag mistake — while gaining the strongest possible locale signal for everything else.

This generalizes. The same "high-precision, high-geo-load token as an anchor" pattern covers
distinctive streets (Champs-Élysées, Shibuya 109) and landmarks (Empire State Building), which the
[exotic-POI understanding docs](../understanding/exotic-poi/landmark-queries.md) already describe as a
domain the BIO parser handles poorly. The postcode is just the most regular member of the family — the
one a regex can catch.

## The anchor layer

An anchor is a span the system can identify with high precision *outside* the neural tagger, that
carries strong geographic information. Anchors are extracted in a cheap pre-pass and injected into the
parser as a **soft, confidence-weighted channel** — never substituted for the raw text, never treated
as ground truth.

### Postcode anchor (the first and most regular)

- **Extractor:** pure regex + a fuzzy gazetteer. Zero-GPU, always-resident, ~2 MB for 15–20 countries,
  microsecond latency, polyfillable in WASM. Damerau–Levenshtein ≤ 1 absorbs OCR / transposition /
  truncation noise.
- **Resolves to a posterior, not a country.** 5-digit formats collide across US/DE/FR/ES/IT, so the
  extractor returns a distribution (`75001` → `{FR: 0.98, US: 0.02}`) plus region and centroid, and
  lets the parser settle the rest from context. The gazetteer membership test is the primary
  disambiguator; shape (alphanumeric UK/NL/CA can never be a house number) and neighbouring tokens are
  secondary.
- **Injected as a prepended `[POSTCODE-ANCHOR]` embedding** encoding (country-posterior, region,
  centroid, confidence). The raw tokens stay untouched so the model can see — and recover from — a
  mistyped or out-of-gazetteer code.
- **Anchor-dropout ~20%** during training (replace with a learned `[NO-ANCHOR]` embedding) so the model
  never *depends* on the anchor. This keeps it a soft prior and closes the circularity (anchor
  conditions the parse, parse feeds the resolver) without laundering errors.

### Position: aware, not required

The extractor finds a postcode wherever a human put it (robust to positional error), but position is
**not discarded** — it is one feature feeding the candidate's confidence, because some house numbers
look like postcodes. The collision is narrow (only purely-numeric-postcode countries; house numbers are
usually 1–4 digits) but real: `12345` is simultaneously a valid US ZIP (Schenectady) and a plausible
house number, so gazetteer membership alone does not always decide. The resolution is not a smarter
extraction rule — it is **honest uncertainty**: an ambiguous candidate carries low confidence, the
anchor channel propagates that, and the parser plus surrounding context makes the final call. The
extractor's job is high-*recall* candidate generation with calibrated confidence, not a high-precision
hard decision.

### Generalized anchors: distinctive streets, landmarks, districts

The same mechanism, with a salience-weighted place gazetteer + fuzzy/alias matching instead of a regex.
Three pipeline placements, decided by the **router** (see coarse placer), by query type:

| Query type | Example | Pipeline placement |
| --- | --- | --- |
| Bare landmark / POI | `Empire State Building`, `Shibuya 109`, `Odori Park` | **Skip the parser** — resolve directly as a venue. Running BIO on it hallucinates spans. |
| Distinctive street in an address | `350 Fifth Avenue`, `10 Downing Street` | Anchor **conditions** the parser (strong city/country prior); parser still runs. |
| Distinctive district / component | `Ginza`, `2-Chōme` | Locality/neighbourhood anchor; conditions parser + resolver. |

**Guardrails (these are load-bearing):**

1. **Salience is data-driven, never a hand-curated VIP list.** "Champs-Élysées is special" must fall
   out of OSM/WOF popularity + uniqueness scores, not a hardcoded entry. A hand-maintained famous-list
   is the "just one more rule" rule-creep trap with better taste — forbidden.
2. **Ambiguity-aware.** Champs-Élysées is near-unique (sharp prior); Broadway, Main Street, and Fifth
   Avenue exist in dozens of towns (weak, multi-modal prior). Anchors emit a posterior over candidates
   and must not over-commit on a common name ("Broadway Avenue, Springfield" must not anchor to NYC).
3. **Concepts are past the parser's fence.** "The Hajj" refers to a place (Mecca) but is not a place
   name — resolving it is semantic entity-linking / concept-aliasing, a different subsystem near the
   resolver (where "Macca's → McDonald's" alias logic conceptually lives), not the address parser. The
   parser must not grow into a general world-knowledge base; that surface is unbounded.

## The model architecture

### Script routes; address-system conditions within

Routing must be cheap *and* reliable. **Script** is (Unicode block regex — free, zero errors).
Address-system similarity is the *right* clustering for the model's job (UK and US share a script but
differ in system; DE and AT share a system across a language border), but it is **not detectable
pre-parse** — knowing the system is most of the parse, so routing on it is circular. The resolution is
the Pareto-optimal point: **route by script, specialize by address-system inside each shard via
conditioning.** One Latin shard (US, UK, DE, FR, ES, IT, NL, BR, MX… as conditioned locales), one
CJK+ shard (JP/KR/CN share descending-locality structure), one Arabic, one Indic. Awkward cases (UK,
tri-lingual CH, ES-Spain vs ES-LatAm) are locales *within* the Latin shard.

The two axes have different jobs: **script routes; address-system subdivides a shard only on capacity
overflow** (see cross-pollution metric). That is why both appeared in the discussion — they are not
competing answers, they operate at different layers.

### Self-conditioning over a hard locale token

In production we usually receive a raw string with no reliable country hint — detecting the country
*before* parsing is most of what the parser exists to do, so a hard external `[locale]` token is close
to assuming the answer. Instead the model reads the whole sequence, infers a soft locale posterior, and
conditions its own per-token labeling on it (layernorm modulation / posterior-as-feature). This is
materially different from the implicit mixing that failed v0.8.0: the ambiguity is resolved *globally*,
before per-token labels. The postcode anchor, when present, is the strongest input to that posterior;
when absent, the model falls back to text-only self-conditioning. Optional 15–20% locale-token-dropout
lets an external hint help without becoming a dependency.

### Coarse placer + graceful abstention (the "Eurasia / off-map" tier)

A tiny always-resident model (a one-layer 32-dim transformer or a fastText-style linear classifier, a
few hundred KB) predicts (script, continent, coarse-region) with a **temperature-calibrated**
confidence, trained with a little outlier exposure (unseen scripts as an "other" class) so it knows the
edge of its own competence. Below threshold it **abstains** — "probably East-Asian, off my loaded map"
— instead of confidently mis-parsing. It runs first, gives an instant coarse answer, and routes which
script shard to download. This is the selective-geography product story: ship ~28 MB that places the
planet coarsely, fetch the region you care about for street-level detail (tiered loading, no permanent
whole-world footprint).

### Does conditioning really isolate, or just paper over?

A conditioned shared model is modulated, not hard-isolated — its FFN/attention weights are shared. The
DeepSeek read is that conditioning *functionally* specializes up to ~20–30 locales per shard at ≥300-dim
hidden (we have 384), so our 15–20 target sits inside the safe regime; the German collapse was a
training-schedule artifact, not a shared-weights limit. **Treat the capacity numbers as directional
estimates, not gospel** (the same source over-called the tokenizer wall, which our own
`diag-tokenizer-multiscript.ts` walked back). The part we trust is the falsifiable tripwire below.

## Decision rules (pre-registered)

- **No promotion on parser-F1 alone.** The resolver is the judge. German's pre-experiment resolver
  locality-match was already 77.4% (v0 79.4%) — a weak parser the resolver absorbed — so a from-scratch
  retrain for German *alone* is not justified. Keep v0.7.2; **batch** the locale expansion.
- **Retrain trigger (resolver terms):** a locale's resolver utility falls below threshold (~<80% city
  match), OR adding a locale drops an existing one's resolver utility >2pp (the 77→43 collapse).
- **Cross-pollution / capacity tripwire:** per-locale, the rate of city-start tokens mis-tagged as
  postcode must fall below 1% by 20k steps with balanced data and conditioning present. If it will not
  clear 1%, that shard has hit its interference ceiling → split it **by address-system** (not by more
  script).
- **Coarse placer:** abstain below the calibrated confidence threshold rather than emit a confident
  wrong placement.

## Staged plan

1. **Now — nothing to production.** v0.7.2 stays; no urgency. Drop the decoder span-merge and
   CRF-transition ideas for German (the diagnostic killed both).
2. **This week, no GPU, highest ROI — the postcode anchor.** Build (a) a postcode → country-posterior +
   region + centroid gazetteer for the target locales from OpenAddresses (US already exists:
   `postalcode-us.db`, 42,319 codes; the global admin DB currently has *zero* postcodes), and (b) the
   regex + fuzzy extractor with calibrated confidence. Helps the resolver *today* and becomes the
   parser's strongest conditioning channel. In parallel: stage ES/IT/NL order shards (same
   synth-from-real-OA recipe) and clean the OpenAddresses CITY noise.
3. **De-risk pilot (~$3–8).** From-scratch US/FR/DE with self-conditioning + the postcode-anchor channel
   + dropout on both signals, stopped at the 20k gate (cross-boundary error <1%, DE locality F1 ≥70% and
   rising, US/FR within 1pp, anchor/token-free degradation ≤5pp). Validates the architecture before any
   scale spend. Test the postcode anchor and self-conditioning *together*.
4. **Real run.** One from-scratch, balanced, self-conditioned run once the pilot passes and 4–5 locales
   are staged.
5. **Global.** Script-shard collection + the coarse-placer tier; the generalized place-anchor gazetteer
   for distinctive streets / landmarks; subdivide a shard by address-system only if its 20k tripwire
   refuses to clear.

## Related

- [German order-shard postmortem](../evals/2026-06-02-night-4-postmortem.md) — the failure that
  motivated this.
- [Resolver routing plan](./2026-05-30-resolver-routing-plan.md) — Direction C; the router this builds
  on.
- [Exotic-POI understanding docs](../understanding/exotic-poi/landmark-queries.md) — the landmark /
  franchise / regional-variant / transit query domains the generalized anchors target.
- DeepSeek consults: German conditioning + resolver routing (paths in the header).
