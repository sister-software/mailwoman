# Phase 2 exit report — link audit (Phase 2j)

Dated 2026-07-14. Base `e051ae4f` (Phase 2i squash, `origin/main`), audited on
`docs/phase2j-link-audit`. Auditor role: measure exit criteria against the live docs, fix only
trivial link/frontmatter gaps, log everything else. This report is the record; see
`docs/superpowers/plans/2026-07-14-documentation-architecture-cleanup.md` for the plan text and
`docs/superpowers/inventory/{baseline,concepts,understanding,plan,misc}.md` for the Phase 0
inventories cited throughout.

Verification method: a full `yarn workspace @mailwoman/docs build`, run twice (before and after the
five edits below), plus direct inspection of the generated `build/docs/**/index.html` for sidebar
and switcher markup. `baseline.md` used the same method, so the before and after numbers are
comparable.

---

## 1. Phase 2 exit criteria — verdicts

**Criterion (plan §Phase 2): "the four goal questions have one primary answer each; prominent
concepts have an explicit owner and a source-of-truth link."**

| #                                                                                                     | Verdict               | Evidence                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Four goal questions have one primary answer each, ≤2 section choices, without plan/history or archive | **PASS**              | See click-path table §2. All four improved from baseline's 2 PASS / 2 FAIL to 4/4.                                                                                |
| Prominent concepts (canonical pages) have explicit role + source-of-truth                             | **PASS, after 1 fix** | 5 of 6 target pages already had `role`/`audience`/`source-of-truth`; `what-mailwoman-is.mdx` was missing all three — fixed (edit #1, §4). See interface table §3. |

## 2. Click-path table — four goal questions, before vs. after

Traced from `/docs/` (the docs landing surface a reader hits from the navbar "Docs" link).
"Section choice" = a DocsSubHeader switcher click (`Start here` / `Use Mailwoman` / `Understand` /
`Reference` / `Contribute` / `Archive` / …), per the plan's own vocabulary.

| Question                                                  | Baseline (`baseline.md`, `55b5e919`)                                                                                                                                                                                                                                              | Current (`e051ae4f` + this audit)                                                                                                                                                                                                                                                                                                                                   | Verdict                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| (a) What does Mailwoman do, when to use it?               | Homepage 0 clicks (good). Navbar "Docs" → `/docs/status`, a dense changelog — **not** an intro; deep answer (`what-mailwoman-is.mdx`) needed the switcher, undiscoverable from a status page.                                                                                     | Homepage 0 clicks (unchanged). Navbar "Docs" now **is** `/docs/` — the fork-in-the-road front door (`articles/index.mdx`), a capsule answer + explicit "I want to…" forks, 0 additional clicks. Deep page `what-mailwoman-is.mdx`: Understand (1 section choice) → Concepts category.                                                                               | **pass** (was: adequate only via homepage)                        |
| (b) How do I parse, geocode, integrate?                   | Homepage "Read the docs" → `/docs/getting-started` (1 click). Navbar "Docs" → `/docs/status` → Getting started (2 clicks). Entry-point contradiction: `getting-started.mdx` opened with `NeuralAddressClassifier`, `api.mdx` calls `createRuntimePipeline` the recommended entry. | Homepage "Read the docs" → `/docs/getting-started` (1 click, unchanged). Front door has a direct "Get started →" link (0 switcher clicks). **Entry-point contradiction fixed** (Phase 2b, `03140a4f`): `getting-started.mdx`'s first code sample now uses `createRuntimePipeline`, matching `api.mdx`. Recipes: Use Mailwoman, 1 section choice.                    | **pass** (was already best of the four; contradiction now closed) |
| (c) How does the system work at a useful technical level? | Content existed and was good but unreachable from homepage/navbar; `/docs/status` → switch to Understanding/Concepts (2 clicks, plus discovering the switcher existed at all).                                                                                                    | Front door **directly links** "How Mailwoman parses an address →" — 0 switcher clicks, 1 click from `/docs/`. Also reachable via Understand (1 section choice) → Concepts category, where it's `sidebar_position: 1`.                                                                                                                                               | **pass** (was: inadequate — content good, path wasn't)            |
| (d) Authoritative interface or operational procedure?     | 3+ clicks past navbar plus a manual expand behind a lowercase, 🧪-flagged, auto-labeled `reference` category; clicking the category header itself misrouted to an unrelated tokenizer report; `SCHEMA.mdx` had zero frontmatter.                                                  | `Reference` switcher (1 section choice) lands directly on `SCOPE.mdx`; `SCHEMA.mdx` ("Component Schema") is now a **flat, un-nested, correctly-titled** top-level entry in that same sidebar, reached with 1 more click and without an expand or misroute. Operational procedure (`OPERATIONS.mdx`): `Contribute` switcher (1 section choice) → flat list, 1 click. | **pass** (was: inadequate — the roughest of the four)             |

Net: 4/4 PASS, up from baseline's 2/4. `SCHEMA.mdx` itself still has zero frontmatter, so its title
falls back to its H1, "Component Schema", which reads fine. This is noted in §5 and does not block
the criterion, because the page is reachable and correctly labeled.

## 3. Canonical-page interface table

Per brief: the four canonical concept pages (`how-mailwoman-parses-an-address.mdx`,
`how-mailwoman-resolves-a-place.mdx`, `data-locales-and-coverage.mdx`, `quality-and-evaluation.mdx`)
plus `what-mailwoman-is.mdx` and `documentation-map.mdx`. Each must declare
`role`/`audience`/`source-of-truth` and link to (a) ≥1 Reference interface page and (b) evidence
(evals/dated records) where it makes evidence-graded claims.

| Page                                           | role/audience/source-of-truth           | Links to Reference                                                                                               | Links to evidence                                                                                          | Verdict        |
| ---------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------- |
| `concepts/how-mailwoman-parses-an-address.mdx` | present (all 3)                         | `plan/reference/SCHEMA.mdx`                                                                                      | `evals/index.mdx`                                                                                          | PASS           |
| `concepts/how-mailwoman-resolves-a-place.mdx`  | present (all 3)                         | `plan/SCOPE.mdx`, `plan/reference/coverage-overlay.mdx`                                                          | `evals/resolver-geo/index.mdx`                                                                             | PASS           |
| `concepts/data-locales-and-coverage.mdx`       | present (all 3)                         | `plan/reference/address-data-sources.mdx`, `plan/reference/coverage-overlay.mdx`, `licensing/data-provenance.md` | `evals/index.mdx`, `evals/competitive-parity/index.mdx`, `evals/resolver-geo/index.mdx`                    | PASS           |
| `concepts/quality-and-evaluation.mdx`          | present (all 3)                         | `plan/CONTRIBUTING_MODEL_WORK.mdx`, `plan/reference/eval-ledger.schema.json`, `plan/SCOPE.mdx`                   | `evals/scores-by-version.json`, `evals/competitive-parity/*`, `evals/calibration/*`, `evals/experiments/*` | PASS           |
| `concepts/what-mailwoman-is.mdx`               | **was missing all 3** — fixed (edit #1) | `plan/reference/closed-vocab-fields-model-first.mdx` (pre-existing)                                              | `evals/competitive-parity/parity-scorecard-2026-06-09.md` (pre-existing)                                   | pass after fix |
| `documentation-map.mdx`                        | present (all 3)                         | **had zero outbound links at all** — fixed (edit #2)                                                             | n/a — page makes no evidence-graded claims (it describes nav structure)                                    | pass after fix |

## 4. Edits made (5, all ≤3 lines)

1. **`docs/articles/concepts/what-mailwoman-is.mdx`**: added the missing `role: concept`,
   `audience: product-reader`, `source-of-truth: plan/SCOPE.mdx, plan/reference/closed-vocab-fields-model-first.mdx, plan/reference/ARCHITECTURE.mdx`
   frontmatter. The page previously had only a title and tags.
2. **`docs/articles/documentation-map.mdx`**: the Reference bullet mentioned "the current scope
   declaration" and "the `ComponentTag` schema" in prose, and the page had zero hyperlinks. Linked
   them to `plan/SCOPE.mdx` and `plan/reference/SCHEMA.mdx`.
3. **`docs/articles/concepts/README.mdx`**: the section's reading-path paragraph mentioned only 2
   of the 4 canonical pages (`how-mailwoman-parses-an-address.mdx`, `what-mailwoman-is.mdx`). The
   other two (`data-locales-and-coverage.mdx`, `quality-and-evaluation.mdx`) had **zero inbound
   links from anywhere in the docs tree** and were reachable only by scrolling the sidebar. Extended
   the paragraph with one sentence linking all three remaining canonical pages.
4. **`docs/articles/concepts/importance-vs-population.mdx`**: a `keep`-flagged reference page with
   zero outbound links. Added a link to `plan/reference/WIKIPEDIA_IMPORTANCE.mdx`, which covers the
   same ETL pipeline this page's `place_importance` build step describes.
5. **`docs/articles/concepts/record-matcher-data-catalog.md`**: a `keep`-flagged page with zero
   outbound doc links. Added a link back to `geocode-first-record-matching.mdx`, the main concept
   page for the cluster this catalog belongs to.

A full clean `yarn workspace @mailwoman/docs build` after the edits exited 0, with the same 9
pre-existing, unrelated tag warnings and zero new broken-link, anchor, or markdown-link warnings.

## 5. Acceptance-measures spot-check (brief item 4)

| Measure                                                        | Verdict                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First-parse path avoids `plan/`/archive                        | **PASS**                | Front door → "Get started →" → `getting-started.mdx`; homepage → "Read the docs" → same. Neither touches `plan/` or the Archive switcher.                                                                                                                                                                                                                                                                                                                         |
| No accidental autogenerated archival dump in reader-facing nav | **PASS, with a nuance** | `Archive` is its own explicit, separately-labeled switcher section (`sidebars.ts`) rather than the default landing anywhere. `Understand`'s sidebar nests several `autogenerated dirName` categories, but the categories themselves and their labels are hand-curated (Phase 1, `adf0761b`) — the _directories_ are auto-listed, the _section structure_ is not. This matches the plan's own Phase 1 description of the mechanism rather than an accidental dump. |
| Docs build passes                                              | **PASS**                | `yarn workspace @mailwoman/docs build` exit 0, twice (before and after edits). 0 broken doc links, 0 broken anchors, 0 broken markdown links — full log has only the 9 pre-existing `tags.yml` warnings baseline.md already noted as out of scope.                                                                                                                                                                                                                |

## 6. Maintained-concepts link pass (concepts/, `keep`/`rewrite` rows only)

Scanned outbound-link counts for all 47 `keep`/`rewrite` rows in `concepts.md` (see method: strip
frontmatter, count `](...)` targets, split internal vs. external). Three pages had **zero internal
doc links**. Two of them, `importance-vs-population.mdx` and `record-matcher-data-catalog.md`, were
dead ends and are now fixed (edits #4, #5). `how-mailwoman-compares.mdx` also has 0 internal links,
but it is a well-connected hub that 5 inbound switching-from-* pages point at, so a reader arriving
there is not stuck. It does not link _forward_ to those guides. That gap is logged in §7 and was not
fixed here, because fixing it means restructuring a table page instead of adding 1–3 lines.

All other 44 `keep`/`rewrite` pages have ≥1 internal link. I spot-checked several previously flagged
stale-claim pages from `concepts.md` (generated 2026-07-14 from each page's content as of its last
edit) and found that earlier Phase 2 work had already corrected them:

- `crf-decoder.mdx`, `viterbi-and-bio-validity.mdx`, `bio-labels.mdx`: the "learned CRF transitions
  are coming" claims are gone. All three now correctly state CE-only training since v0.5.0/v0.6.3 and
  cross-link `dual-loss-curvature-conflict.mdx`.
- `neural-classification.mdx`: now a correctly frontmattered transition stub pointing at
  `how-mailwoman-parses-an-address.mdx` and `how-the-model-reasons.mdx` (Phase 2f/2c).
- `resolver-and-wof.mdx`, `tokenization.mdx`, `README.mdx`: Phase 2f's "six stale-claim fixes"
  (`ee92dd6c`) covered these. I verified that the current content matches what shipped (checked
  `node:sqlite`, tokenizer v0.9.0-multisplice, and the address-point coverage claims).

`wof-data-pipeline.mdx` was **not** part of that sweep. It still carries the stale "Status (updated
2026-05-26)" block calling the WOF prepare pipeline stalled. It is logged as a gap and was not fixed
here, because it needs a paragraph-level rewrite instead of a link fix.

## 7. Remaining gaps (not fixed — logged for the next phase/author pass)

**In-scope findings from this audit that were left unchanged because they exceed the 1–3-line fix
bar:**

- `wof-data-pipeline.mdx` still carries a stale "Status (updated 2026-05-26)" block describing the
  prepare/PlacetypeDataSource pipeline as stalled with an incomplete Redis migration; current pages
  (`fst-gazetteer-prior.mdx`, `importance-vs-population.mdx`) reference the same pipeline as mature
  and shipped. Needs a status-block rewrite rather than a link add.
- `neural-classification.mdx` transition-stub links: Phase 2f repointed 3 inbound links
  (`training-pipeline.mdx`, `onnx-runtime.mdx`, `why-a-neural-parser.mdx`). 8 more inbound links
  still promise transformer/architecture depth the stub no longer delivers:
  `understanding/our-approach/the-staged-pipeline.mdx` (itself `merge`-flagged, may be moot),
  `concepts/tokenization.mdx`, `concepts/fst-gazetteer-prior.mdx`, `concepts/rule-based-classifiers.mdx`
  (×2), `understanding/why-its-hard/addresses-that-break-geocoders.mdx` (×2),
  `understanding/our-approach/how-it-works-now.mdx`. The fix is the same pattern as Phase 2f's
  sweep, applied to the rest of the inbound set.
- The record-matching cluster (`cross-registry-linking.mdx`, `dedup-entity-truth.mdx`,
  `record-matcher-data-catalog.md`, `spatial-expectation-and-density.mdx`) is still not linked
  _from_ its main page, `geocode-first-record-matching.mdx`, which has no "See also" section. Adding
  one is a small content addition, larger than a 1–3-line audit fix.
- `how-mailwoman-compares.mdx`: the inventory marks it `role: reference`, but it carries no
  `role`/`audience`/`source-of-truth` frontmatter. It is the stated hub for the 5 switching-from-*
  guides, yet it links to none of them, and only the guides link back to it. It was not one of the
  six pages this audit's brief put in scope for the frontmatter check.
- `plan/reference/SCHEMA.mdx` has no frontmatter at all, so its title falls back to its H1. The H1
  ("Component Schema") reads fine as a sidebar label, so this is harmless today, but it is
  inconsistent with the content-model interface for a `reference`-role page.
- Two Phase-0-flagged merges are still undone: `fst-gazetteer-prior.mdx` /
  `fst-priors-as-shallow-fusion.mdx` (overlapping FST-prior mechanics), and
  `plan/reference/record-matcher-sources.md` / `concepts/record-matcher-data-catalog.md`
  (near-duplicate prose, same subject).
- The row count in `concepts.md`'s inventory table is now stale. It lists 50 pages, and the
  directory now holds 54 (the 4 new canonical pages added across Phase 2a/2e/2g/2h). The existing
  rows are still correct. Future phases reading `concepts.md` should know that the 4 canonical pages
  are missing from it.

**Queued externals (included verbatim per the brief). Each was confirmed still pending, and this
audit did not change them:**

- Demo R2 asset repoint pending.
- #1117 fr-fr weights pin.
- v6.1.0 ledger row unappended. Confirmed: `evals/scores-by-version.json` still tops out at the
  `5.9.0` (`v2-4-1-fr-nsplice-ft`) row, and neither a `6.0.0` nor a `6.1.0` row exists.
- `releases.mdx` "In flight" stale #884 row. Confirmed still present at line 64 (`releases.mdx`),
  even though the same file's version-matrix row for **5.1.0** (line 41) already documents #884 as
  shipped ("The diacritic tokenizer splice").
- The sotm proposal's dated claim. Confirmed still live: `sotm-2026-talk-proposal.mdx` says the
  source repo is "scheduled for public release at the end of June 2026, ahead of the conference", and
  `contributing.md` (edited more recently) still describes the repo as "in the final stage of
  preparation for public release." The end of June has passed (today: 2026-07-14) without that
  release.
- `understanding/`-tree curation deferred to Phase 3.

## 8. Out of this audit's scope entirely

These items were not re-verified here, because they fall outside the brief's four checklist items
or the plan's coordination boundary delegates them elsewhere:

- The baseline's duplicate-title findings. `Retrospectives` ×2 is in evals/retrospectives, a
  delegated section. The `Start here` title collision between `understanding/README.mdx` and the
  `startHere` switcher label is in scope, but it is not part of the four checks this audit ran
  (click paths, canonical interfaces, and the link pass).
- Liveness of external `https://` links. The baseline also scoped this out, because Docusaurus's
  build-time checker does not cover it.
