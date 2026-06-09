# Resolver routing + end-to-end eval — execution plan (2026-05-30)

**Direction C.** Operationalize the capability map by routing each input to the
parser that wins on it, feeding the (already-shipped) WOF resolver — and build
the first end-to-end "address → correct place" benchmark to prove it. US-first.
DeepSeek-signed (consult: `.agents/skills/deepseek-consult/session-notes-2026-05-30-resolver.md`).

## Why

The resolver (Phase 4) is shipped and works end-to-end: `parse → resolveTree →
WOF place + coords`, with parent-constraint inheritance and FTS5/population/
proximity ranking over US admin + postcodes. But it consumes **neural-only**
output. The capability map (three unbiased arenas) says neither parser
dominates — **input quality decides**: rules win clean/canonical (libpostal v0
29% > neural 16%), neural wins noisy/degraded (perturbation neural 61% > v0 39%).
So neural-only leaves v0's clean-input win on the table. And we have **no
end-to-end accuracy number** — the resolver has unit tests but nothing measures
whole-stack correctness.

## Architecture (target)

A per-input **routing layer** in front of the resolver:

- **Cheap lexical "canonical-ness" scorer** (pre-parse, O(n) on the raw string):
  comma/delimiter count, capital-word ratio, gazetteer-token hits (WOF FST/bloom),
  ZIP-shape digits, word-length distribution → a tiny logistic regression →
  `p(v0-wins)`. Interpretable + debuggable; no extra parse cost.
- **Confidence bands:** `p > 0.8` → v0; `p < 0.2` → neural; the narrow ambiguous
  band → **resolver-as-arbiter** (run both, resolve both, pick the higher
  resolver-confidence result). Caps the 2× parse cost to a small traffic slice.
- **resolver-as-arbiter** is the powerful core mechanism — it makes
  _resolvability_ (gazetteer support) the routing signal, directly optimizing the
  end goal. Used three ways: online fallback (ambiguous band), offline
  auto-labeler for the scorer, and eval oracle.
- **No fusion** in v1 (merging v0's flat record + neural's tree is brittle — a
  bad `PARENT_OF` nesting poisons the resolver's parent-constraint inheritance,
  its main strength). Revisit only if data demands it.

### The output-contract constraint

v0 → flat `ClassificationRecord[]`; neural → `AddressTree`; resolver consumes a
**tree**. So routing v0 into the resolver requires a **flat→tree adapter**
(`PARENT_OF` containment). This adapter is the linchpin — on the critical path
for every v0-involving baseline.

## Build order (each step yields an evaluable artifact)

**Phase 1 — prove the thesis (no routing code yet):**

1. **Eval harness + ground truth.** WOF-bootstrap: sample stratified US WOF
   places (localities/regions/postcodes; urban/rural/territories) → render to
   address strings via templates (full / no-street / state+ZIP) → **canonical +
   perturbed** variants (lowercase, no-comma, glued `NY14201`, mis-split ZIP,
   OCR). Label = WOF id at the rendered specificity (hierarchy-tolerant). Plus
   the golden 4561-row set as a **regression detector only** (it's Pelias-lineage
   — overstates v0). Metrics: **hierarchy-tolerant Place-Match Acc@1** (primary),
   coordinate error p50/p90, component-F1 (isolates parser vs resolver error),
   resolver success rate.
2. **v0→tree adapter** (`PARENT_OF` + tree builder). _Preliminary gate:_
   v0-via-adapter must reach **≥85% of v0's standalone component accuracy** on
   canonical golden — else the adapter is destroying info; fix before proceeding.
3. **Single-parser baselines:** neural-only, v0-via-adapter, on the eval suite.
4. **Resolver-arbiter (offline script):** dual-parse + dual-resolve + pick best
   score → the **arbiter** and **oracle** baselines.

**KILL/CONTINUE GATE (the point of Phase 1):**

> On WOF-bootstrap, the **tuned** arbiter must beat the better single-parser
> baseline by **≥5pp Acc@1 on the clean subset**, **not regress >1–2pp on the
> perturbed subset**, and **≥3pp overall**, with coordinate error not >10% worse.
> Oracle sits above arbiter (= headroom for the router).
>
> If met → routing is worth building (Phase 2). If arbiter ≈ neural-only →
> routing is a dead end; **pivot to coverage** (the backlog's B3'/B5) instead.

**Phase 2 — build routing (only if the gate passes):** 5. **Auto-label** a real unlabeled corpus (OpenAddresses US strings): run both,
resolve both, label by resolver-score delta — _drop both-garbage rows_
(both below calibrated min-score) and _drop marginal rows_ (delta < win
margin; these belong in the online ambiguous band). Calibrate min-score +
win-margin on the WOF-bootstrap set first. 6. **Lexical quality scorer** (LR on the auto-labels) — the cheap approximation
of the arbiter, so we pay 2× parse only on the ambiguous band. 7. **Online router** with confidence bands; thresholds set from the eval suite;
ambiguous band → dual-parse + arbiter (reuse the shipped resolver). 8. **Tune + monitor:** log 1% dual-parse samples, compare router vs arbiter,
retrain on decay.

**Follow-on (parallel, droppable):** OpenAddresses eval track (~10k real US
`{address, lat/lon}` points) → independent great-circle coordinate-error number
for external credibility. Not on the gate's critical path.

## First PR scope (Phase 1, steps 1–2)

The eval harness + WOF-bootstrap generator + the v0→tree adapter (with its
preliminary 85% gate). That unblocks the baselines + the kill/continue gate. No
production-pipeline changes — all of Phase 1 is offline scripts + one adapter.

## Risks / honesty guards

- **Eval circularity:** WOF-bootstrap resolves WOF-rendered strings back to WOF.
  Mitigated by 142k-candidate ambiguity (real Springfield problem) + perturbation
  stress + the golden regression set; the OA follow-on track is the independent
  check. Don't oversell WOF-bootstrap as "real-world" until OA lands.
- **Admin-level ceiling:** the resolver resolves locality/region/postcode, not
  street/house. "Correct place" = right city/ZIP, not right building. Street-level
  (OSM/OpenAddresses) is a later phase.
- **Resolver score isn't a probability:** calibrate before using it as arbiter
  threshold or auto-label signal; reject below a min-score (both-garbage).
