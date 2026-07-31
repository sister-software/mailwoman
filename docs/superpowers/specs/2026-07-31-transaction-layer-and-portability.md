# The transaction layer, and the regulated-monopoly portability thesis

2026-07-31. Operator observation + Claude. Two things: one concrete gap in Phase 3 that a worked
analysis exposed, and one thesis about where this architecture generalizes. The first is actionable
now; the second is explicitly **a thesis, not a roadmap commitment** — see §4 on scope discipline.

## 1. What the WOW analysis actually demonstrated

A conversational analysis of one filer's ownership (2026-07-31) produced, in a few minutes: the
transaction chain (WOW → DigitalBridge + Crestview, Dec 2025, $1.5B EV / $5.20 per share → SoftBank
acquiring DigitalBridge itself, ~$4B, approved by its shareholders April 2026, FCC application filed
February 2026), the implied multiple (~5.5x EBITDA, ~$3,280 per broadband subscriber against 457,100
subs and $68.8M quarterly adjusted EBITDA), the structural read (an overbuilder squeezed between
fiber above and fixed wireless below, so the scarce asset is plant rather than the retail book), the
named playbook (PropCo/OpCo separation, with Windstream/Uniti as its canonical failure), and a
checkable open question (whether common upstream ownership now spans two nominally competing
providers in the same markets).

Every input was public. None of it was assembled from a durable substrate — it was web fetches plus
arithmetic plus recall, which is unreproducible, unsourced, and unauditable. **The product is that
assembly made systematic.** Not the conclusion: the conclusion stays the customer's, per doctrine.
What the customer buys is not having to spend a day in EDGAR, FCC dockets, and trade press to reach
the point where judgment can start.

## 2. The concrete gap: a transaction layer, and where family-edge dates come from

`2026-07-31-evidence-axes-beyond-filings.md` §2.1 established that crosswalk edges must carry
`valid_from`/`valid_to`. It did not say where those dates come from. They come from here:

| Source                                                | What it yields                                                                                 | Notes                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FCC transfer-of-control applications**              | The authoritative date and structure of _every_ change of control over FCC-authorized entities | Filing → public-notice → approval dates are the natural `valid_from`. Applications disclose post-transaction ownership structure. Foreign acquirers additionally trigger executive-branch review, which is itself a dated public record. **This is the transaction spine.** |
| **SEC merger filings** (8-K, S-4, DEF 14A, 10-K/10-Q) | Price, structure, financing, and the financials that make multiples computable                 | Public parents only; `CIK` is already in the Phase 3 identifier inventory                                                                                                                                                                                                   |
| **State PUC transfer approvals**                      | Per-state conditions and sometimes service-quality commitments                                 | Heterogeneous; deferred with the rest of state sources (D4)                                                                                                                                                                                                                 |

Two consequences:

1. **`valid_from` becomes populatable rather than aspirational.** An FCC transfer approval is a dated,
   authoritative, public assertion that control moved — exactly the "authoritative edge" shape §4.1
   already defines. Add `transfer_of_control` as an edge source type in 3b.
2. **A capital-structure attribute becomes available for the entities that file with the SEC.**
   Leverage and capex trend explain a great deal of filing-versus-reality drift without any inference
   about intent: an operator with declining EBITDA under new leverage stops building to the edge of
   its claimed footprint. Report the attribute and its source; never the motive.

## 3. The portability thesis: regulated monopolies share this shape

The four-layer decomposition is not telecom-specific. Every regulated natural monopoly publishes:
identity (a regulator-assigned ID), physical plant (geocoded, because siting requires permission),
claims (service territory or availability), and transactions (because transfers need approval). The
layers join badly on purpose, and geocoded entity resolution is what makes them join.

Honest ranking of second verticals by data quality, not by market attractiveness:

- **Electric and gas utilities — the strongest fit by a wide margin.** EIA Form 860 is plant-level and
  geocoded with owner identity (a direct ASR analog); EIA Form 861 carries utility service territories
  (a BDC-availability analog); FERC Form 1 gives financials; FERC Section 203 approves transfers (a
  transfer-of-control analog); and holding-company opacity is, if anything, worse than telecom's.
  All four layers exist with federal, public-domain sources.
- **Pipelines** (PHMSA operator IDs and incident data; FERC for interstate gas) — good, narrower.
- **Rail** (Surface Transportation Board: ownership, mergers, network) — good, small buyer set.
- **Water** — weak. EPA SDWIS covers systems and violations, but ownership is mostly municipal and
  poorly structured. Skip.

The abstraction, stated plainly: **mailwoman is a geocoded entity-resolution substrate for
regulated-monopoly public record.** The address parser is the joining primitive because these
datasets key on addresses and coordinates and nothing joins cleanly without one. That framing
explains why the geocoder is the foundation rather than the product — and it is a framing, not a
pivot.

## 4. Scope discipline (binding on this note)

This note is a thesis with one actionable extraction. To keep it from becoming a roadmap:

- **Actionable now:** the transaction layer (§2) folds into Phase 3b, because it makes an already-
  ratified requirement (temporal validity) implementable. Nothing else here changes any phase.
- **Not actionable:** the second vertical. Electric/gas is not started, scoped, or promised until the
  telecom vertical has a paying customer or a published artifact proving the thesis. One vertical
  proven beats two half-built, and the discipline that got 2a and 2b shipped was narrow phases with
  pre-registered gates.
- **The delivery shape is already right.** The BDC spec's "the interface is an agent, not a form"
  holds here: the customer-facing product is an agent with a deterministic, provenance-carrying tool
  belt. This analysis is what that workflow looks like when the substrate exists — which is evidence
  the MCP surface is the correct delivery mechanism, not a reason to build something new.
