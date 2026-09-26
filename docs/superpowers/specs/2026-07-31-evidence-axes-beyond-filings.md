# Evidence axes beyond the filing — design note

2026-07-31. Operator field observations + Claude. This note spans 2b (plausibility), 3d (competition surface),
and C5 (the label/pricing scraper). It is not a phase. It describes axes that the existing bundle shape should grow
to include. The doctrine is unchanged and still applies: we disclose and do not accuse, an absence does not mean
impossibility, and each claim cites its source.

## 1. The benchmark filter — the FCC's own fields already do the sorting

`bdc_availability` already carries `technology_code`, `max_advertised_download_speed`,
`max_advertised_upload_speed`, and **`low_latency`**. These four fields are enough to apply the FCC's
_own_ definitions instead of anyone's judgment:

- **The 100/20 Mbps fixed benchmark** (the Commission's current standard): arithmetic decides whether a filing
  meets it.
- **`low_latency`**: the BDC data model has this flag because round-trip latency is a
  service-defining property that speed alone hides. Geostationary satellite fails it because of orbital
  geometry, which is a physical limit and not a preference.

The product therefore never has to call any technology good or bad. It reports: _of the N filings
in this block, M meet the FCC's 100/20 benchmark with the low-latency flag set._ That line is citable and
defined by the Commission, and it reduces the headline number directly.

**Combined with the family collapse (Phase 3), one block yields three numbers:**

```
filings: 5  →  corporate families: 2  →  meeting 100/20 + low-latency: 1
```

That progression is the most informative output this stack can print, and every step of it
applies someone else's published definition to someone else's published data.

## 2. Axis three: the provider's own address-level availability check

Every major ISP runs a public address-serviceability endpoint on its own site, and since 2024 also
a Broadband Facts label surface. This is a **higher-resolution claim from the same claimant**. It is
address-grained instead of census-block-grained, and the provider publishes it directly instead of through a regulator.

When a provider's own channel and its own filing disagree about the same address, both sides of the
discrepancy are documented, and it requires neither inference nor third-party judgment. It is the strongest class of evidence
this project can produce, because the provider is the sole source of both statements.

Operator-observed worked example (2026-07-31, a residential address on Plumbrook Rd, Sterling
Heights, MI 48313). The house number is deliberately omitted because it is a private home. The filings below
are block-grain public record and make no claim specific to that household:

| Filer                     | FRN        | Provider ID | Filed            | Provider's own channel               |
| ------------------------- | ---------- | ----------- | ---------------- | ------------------------------------ |
| WideOpenWest Finance, LLC | 0001753557 | 131480      | Cable, 1200 Mbps | Site reports address not serviceable |
| Comcast Corporation       | 0003768165 | 130317      | Cable, 2000 Mbps | Markets 2000 Mbps at the address     |

**Corrected 2026-07-31.** An earlier revision of this note transposed the two filed speeds and
concluded from them that "filings diverge in both directions". The corrected example
supports a narrower claim:

- **Comcast filed 2000 and markets 2000, an exact match.** The self-check corroborates the filing.
- **WOW filed 1200, and its own site reports the address as unserviceable.** This divergence concerns availability
  rather than speed. The disagreement is about _whether service exists at all_, which is a different and
  more consequential axis than throughput.

Two design consequences follow, and the second corrects the reasoning of the first revision:

1. **Availability divergence and speed divergence are separate comparisons.** A design that only
   compares advertised speed misses the case that matters most here. Compare serviceability first, and
   compare speed only where both sides agree that service exists.
2. **The comparison stays direction-neutral as a precaution, and no observation supports that choice yet.** The corrected
   example does not show under-claiming. Filings could still understate for mundane reasons,
   such as a vintage that predates a speed upgrade or conservative reporting. The comparison therefore keeps
   `filed_exceeds_channel` / `channel_exceeds_filed` / `agree` instead of a one-way over-claim
   detector. This hedges against a case nobody has observed, and this note should not imply otherwise.
   The output never uses a word that implies intent, in either direction.

**Before reading any divergence as an error, encode the reporting standard.** BDC's availability
definition is not "a customer is connected today". A location is reportable when the provider could
provision service there within a defined short window without extraordinary construction. Verify the
exact current wording against the FCC's BDC reporting instructions before this ships. Franchise-area
or plant-passing interpretations of that standard produce large gaps that fully comply with the rules, between
a filing and a sales funnel that declines the order. The product reports the divergence and cites
the standard. It does not infer that a filer misapplied the standard.

The Comcast case is also technologically self-consistent: "fiber to the street, coax to the
home" is HFC, which _is_ the filed cable technology code. The divergence is in the speed and
availability fields and not in the technology field. Encode this so that the check does not flag correct
technology reporting as a mismatch.

**Salvage:** `isp-nexus/universe/sync/experiments/pluck-att.ts` + `fcc/labels/` already implement this
shape against AT&T (scrape → LLM extraction → Zod `BroadbandLabelSchema`). The salvage survey filed it
under C5 pricing, but it is equally an availability-corroboration source. The same implementation serves both uses.

**Constraints to respect:** these are third-party sites, so each provider's ToS and robots directives
apply. Request volume must stay modest and identified, and results are cached with a timestamp
because they change. We run address-level checks only for addresses a user asks about and never
sweep addresses in bulk.

### 2.1 Filings decay — corporate identity moves faster than filing vintages

The same worked example revealed a second, structural problem: **WideOpenWest was acquired roughly
seven months before this observation** (broadbandbreakfast.com, "WOW acquisition closed"). A
filing that carries WOW's FRN and provider ID therefore describes an entity whose ownership has since changed. The
BDC vintage cadence (a twice-yearly `as_of_date`) guarantees months of lag even without an acquisition.

This is a **schema requirement** and not a data-quality complaint:

1. **Family edges must be time-scoped.** A corporate-family assertion holds _as of_ a date and never
   permanently. Phase 3's crosswalk edges need `valid_from` / `valid_to` (or at minimum a mandatory
   `as_of`), and a family rollup query must take a date. A family graph without dates will
   report today's ownership against a filing from two vintages ago, and nobody will see the error.
2. **Vintage skew must be reported instead of silently reconciled.** When a `filingLandscape` result at
   vintage V is joined to a family rollup current at date D, the output states both. Where the skew
   spans a known ownership change, the answer reports that change.
3. **M&A is a first-class event and not noise.** Consolidation is frequent enough in this sector that
   "the filer of record no longer exists as an independent entity" is a routine state. The spine
   should be able to say so, and that is one of the more useful things it can say. The statement cites the
   transaction record and does not characterize the transaction.

This strengthens the case for Phase 3 in general. Without a time-aware identity layer, every
competition count silently mixes vintages.

## 3. Axis four: crowdsourced performance — real, but licensing-forked

Consumer-facing aggregators (allconnect and similar sites) blend filing data with Ookla measurements.
Their pages therefore report state/city generalities instead of address-level facts, because the
measurement layer has no address grain either.

Performance data is a legitimate fourth axis, because it observes what was delivered instead of what was
claimed. The sources differ sharply on licensing, and licensing decides which ones are usable:

- **Ookla Open Data** is believed to be licensed **non-commercially** (CC BY-NC-SA family). If so, it is
  unusable in a commercial product regardless of its quality. **Verify before any ingest.**
- **M-Lab** is open-licensed and publicly queryable, and it is the more likely candidate.
- **FCC Measuring Broadband America** is federal, public domain, and panel-based, with a small sample and high
  trust.

Neither M-Lab nor MBA gives address grain. Both give area-level distributions, so they are useful
for _corroboration at area grain_. "Filed gigabit service in a block whose measured
distribution has never exceeded X" is a coverage-qualified observation and not a verdict about any
address.

## 4. What this changes downstream

- **2b (now):** no change is required. The bundle's `evidence_found` union and `coverage_detail` axis
  states already accommodate additional axes, so adding them later extends the bundle without a rebuild.
- **3d competition surface:** the three-number progression of §1 becomes the headline output, and the
  benchmark filter is a first-class query parameter.
- **C5:** the label scraper serves two purposes, pricing _and_ availability corroboration.
- **Evals:** the Plumbrook example is a real availability-divergence fixture, with one filer that agrees
  exactly with its own channel and one that files service its own channel declines. The acquisition also makes it a stale-identity
  fixture. Keep it as an internal eval
  case, because a one-way over-claim detector gets exactly this shape wrong.

## 5. Open questions

1. Verify Ookla Open Data's license before any design depends on it (§3). If it is non-commercial, drop it
   and standardize on M-Lab + MBA.
2. Review each provider's ToS for address-check endpoints. Which providers permit programmatic checks,
   at what rate, and does the Broadband Facts label surface have different terms from the sales
   funnel? (§2)
3. Does the benchmark filter belong in `filingLandscape` (as a query option) or only in 3d's competition
   surface? The current preference is a query option, so every consumer gets it without extra work.
