# Evidence axes beyond the filing — design note

2026-07-31. Operator field observations + Claude. Spans 2b (plausibility), 3d (competition surface),
and C5 (the label/pricing scraper). Not a phase; a set of axes the existing bundle shape should grow
into. Doctrine unchanged and binding: disclosure not accusation, absence is not impossibility,
provenance on every claim.

## 1. The benchmark filter — the FCC's own fields already do the sorting

`bdc_availability` already carries `technology_code`, `max_advertised_download_speed`,
`max_advertised_upload_speed`, and **`low_latency`**. Those four are sufficient to apply the FCC's
_own_ definitions rather than anyone's judgment:

- **The 100/20 Mbps fixed benchmark** (the Commission's current standard) — a filing either meets it
  or it does not, arithmetically.
- **`low_latency`** — the BDC data model has this flag precisely because round-trip latency is a
  service-defining property that speed alone hides. Geostationary satellite fails it on orbital
  geometry, which is physics, not preference.

So the product never has to characterize any technology as good or bad. It reports: _of the N filings
in this block, M meet the FCC's 100/20 benchmark with the low-latency flag set._ That is a citable,
Commission-defined line, and it collapses the headline number honestly.

**Stacked with the family collapse (Phase 3), one block yields three numbers:**

```
filings: 5  →  corporate families: 2  →  meeting 100/20 + low-latency: 1
```

That progression is the single most informative thing this stack can print, and every step of it is
someone else's published definition applied to someone else's published data.

## 2. Axis three: the provider's own address-level availability check

Every major ISP operates a public address-serviceability endpoint on its own site (and, post-2024,
a Broadband Facts label surface). This is a **higher-resolution claim from the same claimant**:
address grain rather than census-block grain, and self-published rather than regulator-mediated.

When a provider's own channel and its own filing disagree about the same address, that discrepancy is
documented on both sides — no inference, no third-party judgment. It is the strongest evidence class
this project can produce, because the provider is the sole source of both statements.

Operator-observed worked example (2026-07-31, `8711 Plumbrook Rd, Sterling Heights MI 48313`):

| Filer                     | FRN        | Provider ID | Filed            | Provider's own channel               |
| ------------------------- | ---------- | ----------- | ---------------- | ------------------------------------ |
| WideOpenWest Finance, LLC | 0001753557 | 131480      | Cable, 1200 Mbps | Site reports address not serviceable |
| Comcast Corporation       | 0003768165 | 130317      | Cable, 2000 Mbps | Markets 2000 Mbps at the address     |

**Corrected 2026-07-31** — an earlier revision of this note had the two filed speeds transposed and
drew a "filings diverge in both directions" conclusion from them. What the corrected example actually
shows is narrower and cleaner:

- **Comcast: filed 2000, markets 2000 — exact agreement.** The self-check corroborates the filing.
- **WOW: filed 1200, own site reports the address unserviceable — an availability divergence, not a
  speed one.** The disagreement is about _whether service exists at all_, which is a different (and
  more consequential) axis than throughput.

Two design consequences follow, and the second is a correction of the first revision's reasoning:

1. **Availability divergence and speed divergence are separate comparisons.** A design that only
   diffs advertised speed misses the case that matters most here. Compare serviceability first;
   compare speed only where both sides agree service exists.
2. **Direction-neutrality stays, but as precaution, not as an observed finding.** The corrected
   example does not demonstrate under-claiming. Filings could still understate for mundane reasons —
   a vintage predating a speed upgrade, conservative reporting — so the comparison remains
   `filed_exceeds_channel` / `channel_exceeds_filed` / `agree` rather than a one-way over-claim
   detector. That is a hedge against an unobserved case, and this note should not imply otherwise.
   Never an intent word in any direction.

**Before reading any divergence as error, encode the reporting standard.** BDC's availability
definition is not "a customer is connected today" — a location is reportable when the provider could
provision service there within a defined short window without extraordinary construction (verify the
exact current wording against the FCC's BDC reporting instructions before this ships). Franchise-area
or plant-passing interpretations of that standard produce large, entirely rule-compliant gaps between
a filing and a sales funnel that will decline the order. The product reports the divergence and cites
the standard; it does not infer that a filer misapplied it.

Note also that the Comcast case is technologically self-consistent: "fiber to the street, coax to the
home" is HFC, which _is_ the filed cable technology code. Divergence lives in the speed and
availability fields, not the technology field — worth encoding so the check doesn't flag correct
technology reporting as a mismatch.

**Salvage:** `isp-nexus/universe/sync/experiments/pluck-att.ts` + `fcc/labels/` already implement this
shape against AT&T (scrape → LLM extraction → Zod `BroadbandLabelSchema`). The salvage survey filed it
under C5 pricing; it is equally an availability-corroboration source. Same machinery, second use.

**Constraints to respect:** these are third-party sites, so per-provider ToS and robots directives
govern, request volume must stay modest and identified, and results are cached with a timestamp
because they change. Address-level checks are performed for addresses a user asks about — not swept
en masse.

### 2.1 Filings decay — corporate identity moves faster than filing vintages

The same worked example surfaced a second, structural problem: **WideOpenWest was acquired roughly
seven months before this observation** (broadbandbreakfast.com, "WOW acquisition closed"). So a
filing carrying WOW's FRN and provider ID describes an entity whose ownership has since changed, and
the BDC vintage cadence (biannual `as_of_date`) guarantees months of lag even without an acquisition.

This is not a data-quality complaint; it is a **schema requirement**:

1. **Family edges must be time-scoped.** A corporate-family assertion is true _as of_ a date, never
   eternally. Phase 3's crosswalk edges need `valid_from` / `valid_to` (or at minimum a mandatory
   `as_of`), and a family rollup query must take a date. An untimed family graph will confidently
   report today's ownership against a filing from two vintages ago and be wrong in a way nobody can
   see.
2. **Vintage skew must be reported, not silently reconciled.** When a `filingLandscape` result at
   vintage V is joined to a family rollup current at date D, the output states both. Where the skew
   spans a known ownership change, that fact is surfaced alongside the answer.
3. **M&A is a first-class event, not noise.** Consolidation is frequent enough in this sector that
   "the filer of record no longer exists as an independent entity" is a routine state. The spine
   should be able to say so — it is one of the more useful things it can say — sourced to the
   transaction record, with no characterization of the transaction.

This strengthens the case for Phase 3 generally: without a time-aware identity layer, every
competition count silently mixes vintages.

## 3. Axis four: crowdsourced performance — real, but licensing-forked

Consumer-facing aggregators (allconnect and peers) blend filing data with Ookla measurements,
which is why their pages resolve to state/city generalities rather than address truth: the
measurement layer has no address grain either.

Performance data is a legitimate fourth axis (it observes what was actually delivered, not what was
claimed), but the sources diverge sharply on licensing and that decides which is usable:

- **Ookla Open Data** — believed **non-commercial** licensed (CC BY-NC-SA family). If so it is
  unusable in a commercial product regardless of its quality. **Verify before any ingest.**
- **M-Lab** — open-licensed, publicly queryable, the more likely candidate.
- **FCC Measuring Broadband America** — federal, public domain, panel-based (small sample, high
  trust).

Neither M-Lab nor MBA gives address grain; both give area-level distributions. The honest use is
therefore _corroboration at area grain_: "filed gigabit service in a block whose measured
distribution has never exceeded X" is a coverage-qualified observation, not a verdict about any
address.

## 4. What this changes downstream

- **2b (now):** no change required. The bundle's `evidence_found` union and `coverage_detail` axis
  states already accommodate additional axes; adding them later is additive, not a re-cut.
- **3d competition surface:** the three-number progression of §1 becomes the headline output, and the
  benchmark filter is a first-class query parameter.
- **C5:** the label scraper serves double duty — pricing _and_ availability corroboration.
- **Evals:** the Plumbrook example is a genuine bidirectional fixture. Keep it as an internal eval
  case; it is exactly the shape that a one-way over-claim detector gets wrong.

## 5. Open questions

1. Verify Ookla Open Data's license before any design depends on it (§3). If non-commercial, drop it
   and standardize on M-Lab + MBA.
2. Per-provider ToS review for address-check endpoints — which providers permit programmatic checks,
   at what rate, and does the Broadband Facts label surface have different terms than the sales
   funnel? (§2)
3. Does the benchmark filter belong in `filingLandscape` (a query option) or only in 3d's competition
   surface? Leaning query option, so every consumer gets it for free.
