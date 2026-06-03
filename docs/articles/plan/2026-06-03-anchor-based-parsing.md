# Anchor-based parsing & multi-locale architecture — direction (2026-06-03)

**Direction D.** Some tokens in an address carry far more geographic information than others. The
postcode is the clearest case, with distinctive streets and landmarks close behind. Treat those as
*first-class structured anchors* that condition (or bypass) the neural parser, rather than flattening
them into just-another-BIO-tag. Around that sits a single self-conditioned model per **script** shard, a
tiny always-resident coarse placer for graceful abstention, and a strict soft-prior discipline that
keeps anchors from laundering errors. DeepSeek-signed across two consults (German conditioning:
`.agents/skills/deepseek-consult/session-notes-2026-06-02-german-conditioning.md`; resolver routing:
`.agents/skills/deepseek-consult/session-notes-2026-05-30-resolver.md`).

## Why now

The v0.8.0 German order-shard experiment ([postmortem](../evals/2026-06-02-night-4-postmortem.md))
taught two things at once. The order *is* learnable cheaply: a 5,000-row shard roughly doubled German
street and house-number F1. But the continue-train re-triggered the Saint-Albans span-fragmentation bug
at end-of-string. The model bled the postcode span into the adjacent city (`München` → `chen`, `Berlin`
→ absorbed into the postcode run), which collapsed locality and postcode and dragged the resolver down
with it. The collapse is **emission-level**: raw per-token argmax already fragments, so no decoder
span-merge or CRF-transition table can repair it (both sit downstream of emissions, and the error is
*cross-tag*, a city's lead piece leaking into `postcode` rather than a same-tag split).

The mechanism reframes the whole roadmap. Think about what a postcode actually encodes: a US ZIP runs
northeast to west by its first digit, a UK postcode plus a house number nearly identifies a single
building, and German PLZ and French codes are zone-hierarchical. It is the most information-dense token
in an address, and we were asking a sequence labeler to find it *and* to know where it stops, in one
pass, with nothing telling it the postcode is a different kind of thing from the city sitting beside it.
That framing is the bug. Lift the postcode out with a dedicated high-precision extractor, resolve it,
and feed it back as a conditioning anchor, and the model never gets the chance to make the cross-tag
mistake. It gains the strongest available locale signal for everything else at the same time.

This generalizes. The same "high-precision, high-geo-load token as an anchor" pattern covers distinctive
streets (Champs-Élysées, Shibuya 109) and landmarks (Empire State Building), which the
[exotic-POI understanding docs](../understanding/exotic-poi/landmark-queries.md) already describe as a
domain the BIO parser handles poorly. The postcode is just the most regular member of that family, the
one a regex can catch.

## The anchor layer

An anchor is a span the system can identify with high precision *outside* the neural tagger, one that
carries strong geographic information. We extract anchors in a cheap pre-pass and feed them to the
parser as a **soft, confidence-weighted channel** that nudges rather than overrides. The raw text stays
authoritative.

### Postcode anchor (the first and most regular)

- **Extractor:** pure regex + a fuzzy gazetteer. Zero-GPU, always-resident, ~2 MB for 15-20 countries,
  microsecond latency, polyfillable in WASM. A Damerau-Levenshtein distance of 1 absorbs OCR,
  transposition, and truncation noise.
- **Resolves to a country posterior.** 5-digit formats collide across US/DE/FR/ES/IT, so a single hard
  country call is wrong; the extractor returns a distribution (`75001` → `{FR: 0.98, US: 0.02}`) plus
  region and centroid, and lets the parser settle the rest from context. The gazetteer membership test
  is the primary disambiguator; shape (alphanumeric UK/NL/CA can never be a house number) and
  neighbouring tokens come second.
- **Injected as a prepended `[POSTCODE-ANCHOR]` embedding** encoding (country-posterior, region,
  centroid, confidence). The raw tokens stay untouched, so the model can see, and recover from, a
  mistyped or out-of-gazetteer code.
- **Anchor-dropout ~20%** during training (replace with a learned `[NO-ANCHOR]` embedding) so the model
  never *depends* on the anchor. This keeps it a soft prior and closes the circularity (anchor conditions
  the parse, parse feeds the resolver) without laundering errors.

### Where position fits in

The extractor finds a postcode wherever a human put it (robust to positional error), and position still
counts: it feeds the candidate's confidence, because some house numbers do look like postcodes. The
collision is narrow (only purely-numeric-postcode countries, and house numbers usually run 1-4 digits)
but real. `12345` is at once a valid US ZIP (Schenectady) and a plausible house number, so gazetteer
membership alone does not always decide. So the extractor does not try to win that call. An ambiguous
candidate carries low confidence, the anchor channel propagates the doubt, and the parser plus its
surrounding context makes the final decision. The extractor's job is high-*recall* candidate generation
with calibrated confidence, well short of a high-precision hard ruling.

### Generalized anchors: distinctive streets, landmarks, districts

The same mechanism, with a salience-weighted place gazetteer + fuzzy/alias matching in place of a regex.
Three pipeline placements, decided by the **router** (see coarse placer), by query type:

| Query type | Example | Pipeline placement |
| --- | --- | --- |
| Bare landmark / POI | `Empire State Building`, `Shibuya 109`, `Odori Park` | **Skip the parser** and resolve directly as a venue. Running BIO on it hallucinates spans. |
| Distinctive street in an address | `350 Fifth Avenue`, `10 Downing Street` | Anchor **conditions** the parser (strong city/country prior); parser still runs. |
| Distinctive district / component | `Ginza`, `2-Chōme` | Locality/neighbourhood anchor; conditions parser + resolver. |

**Guardrails (these are load-bearing):**

1. **Salience is data-driven, never a hand-curated VIP list.** "Champs-Élysées is special" must fall out
   of OSM/WOF popularity + uniqueness scores, not a hardcoded entry. A hand-maintained famous-list is the
   "just one more rule" trap with better taste, and we keep it off the table.
2. **Ambiguity-aware.** Champs-Élysées is near-unique (sharp prior); Broadway, Main Street, and Fifth
   Avenue exist in dozens of towns (weak, multi-modal prior). Anchors emit a posterior over candidates
   and must not over-commit on a common name ("Broadway Avenue, Springfield" must not anchor to NYC).
3. **Concepts are past the parser's fence.** "The Hajj" refers to a place (Mecca) without being a place
   name; resolving it is semantic entity-linking, or concept-aliasing, a different subsystem near the
   resolver (where "Macca's → McDonald's" alias logic conceptually lives). The parser stays out of it.
   Grow it into a general world-knowledge base and the surface becomes unbounded.

## The model architecture

### Script routes; address-system conditions within

Routing has to be cheap *and* reliable, and **script** is both: a Unicode-block regex, free and exact.
Address-system similarity is the *right* clustering for the model's job (UK and US share a script but
differ in system; DE and AT share a system across a language border), yet it is **not detectable
pre-parse**, since knowing the system is most of the parse, which makes routing on it circular. So the
Pareto-optimal point is to **route by script and specialize by address-system inside each shard via
conditioning.** One Latin shard (US, UK, DE, FR, ES, IT, NL, BR, MX… as conditioned locales), one CJK+
shard (JP/KR/CN share descending-locality structure), one Arabic, one Indic. Awkward cases (UK,
tri-lingual CH, ES-Spain vs ES-LatAm) are locales *within* the Latin shard.

The two axes have different jobs: **script routes; address-system subdivides a shard only on capacity
overflow** (see the cross-pollution metric). That is why both came up. They operate at different layers.

### Self-conditioning over a hard locale token

In production we usually receive a raw string with no reliable country hint, and detecting the country
*before* parsing is most of what the parser exists to do, so a hard external `[locale]` token comes close
to assuming the answer. Instead the model reads the whole sequence, infers a soft locale posterior, and
conditions its own per-token labeling on it (layernorm modulation, or posterior-as-feature). That
resolves the ambiguity *globally*, before per-token labels, which is the step the implicit mixing in
v0.8.0 skipped. When a postcode anchor is present it is the strongest input to that posterior; when
absent, the model falls back to text-only self-conditioning. An optional 15-20% locale-token-dropout
lets an external hint help without becoming a dependency.

### Coarse placer + graceful abstention (the "Eurasia / off-map" tier)

A tiny always-resident model (a one-layer 32-dim transformer, or a fastText-style linear classifier, a
few hundred KB) predicts (script, continent, coarse-region) with a **temperature-calibrated** confidence,
trained with a little outlier exposure (unseen scripts as an "other" class) so it knows the edge of its
own competence. Below threshold it **abstains**, returning "probably East Asian, off my loaded map"
instead of a confident mis-parse. It runs first, gives an instant coarse answer, and decides which script
shard to download. That is the selective-geography product story: ship ~28 MB that places the planet
coarsely, then fetch the region you care about for street-level detail (tiered loading, no permanent
whole-world footprint).

### Does conditioning really isolate, or just paper over?

A conditioned shared model is modulated, not hard-isolated: its FFN and attention weights are shared. The
DeepSeek read is that conditioning *functionally* specializes up to ~20-30 locales per shard at ≥300-dim
hidden (we have 384), so our 15-20 target sits inside the safe regime, and the German collapse was a
training-schedule artifact rather than a shared-weights limit. **Treat the capacity numbers as directional
estimates, not gospel** (the same source over-called the tokenizer wall, which our own
`diag-tokenizer-multiscript.ts` walked back). The part we trust is the falsifiable tripwire below.

## Decision rules (pre-registered)

- **No promotion on parser-F1 alone.** The resolver is the judge. German's pre-experiment resolver
  locality-match was already 77.4% (v0 79.4%), a weak parser that the resolver absorbed, so a from-scratch
  retrain for German *alone* is not justified. Keep v0.7.2 and **batch** the locale expansion.
- **Retrain trigger (resolver terms):** a locale's resolver utility falls below ~80% city match, or
  adding a locale drops an existing one's resolver utility by more than 2pp (the 77→43 collapse).
- **Cross-pollution / capacity tripwire:** per-locale, the rate of city-start tokens mis-tagged as
  postcode must fall below 1% by 20k steps with balanced data and conditioning present. If it will not
  clear 1%, that shard has hit its interference ceiling, and we split it **by address-system** (not by
  more script).
- **Coarse placer:** abstain below the calibrated confidence threshold rather than emit a confident wrong
  placement.

## Staged plan

1. **Now — nothing to production.** v0.7.2 stays; no urgency. Drop the decoder span-merge and
   CRF-transition ideas for German (the diagnostic killed both).
2. **This week, no GPU, highest ROI — the postcode anchor.** Build (a) a postcode → country-posterior +
   region + centroid gazetteer for the target locales from OpenAddresses (US already exists:
   `postalcode-us.db`, 42,319 codes; the global admin DB currently has *zero* postcodes), and (b) the
   regex + fuzzy extractor with calibrated confidence. It helps the resolver *today* and becomes the
   parser's strongest conditioning channel. In parallel: stage ES/IT/NL order shards (same
   synth-from-real-OA recipe) and clean the OpenAddresses CITY noise.
3. **De-risk pilot (~$3-8).** From-scratch US/FR/DE with self-conditioning + the postcode-anchor channel +
   dropout on both signals, stopped at the 20k gate (cross-boundary error under 1%, DE locality F1 ≥70%
   and rising, US/FR within 1pp, anchor/token-free degradation ≤5pp). It validates the architecture before
   any scale spend. Test the postcode anchor and self-conditioning *together*.
4. **Real run.** One from-scratch, balanced, self-conditioned run once the pilot passes and 4-5 locales
   are staged.
5. **Global.** Script-shard collection + the coarse-placer tier; the generalized place-anchor gazetteer
   for distinctive streets / landmarks; subdivide a shard by address-system only if its 20k tripwire
   refuses to clear.

## Related

- [German order-shard postmortem](../evals/2026-06-02-night-4-postmortem.md) — the failure that motivated
  this.
- [Resolver routing plan](./2026-05-30-resolver-routing-plan.md) — Direction C; the router this builds on.
- [Exotic-POI understanding docs](../understanding/exotic-poi/landmark-queries.md) — the landmark /
  franchise / regional-variant / transit query domains the generalized anchors target.
- DeepSeek consults: German conditioning + resolver routing (paths in the header).
