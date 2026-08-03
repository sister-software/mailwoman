# Docs reorganization — three audiences, fresh site — design

**Date:** 2026-08-03
**Status:** approved by operator (conn handed off after section 2; sections 3–6 settled under that authority)
**Predecessors:** `docs/superpowers/plans/2026-07-14-documentation-architecture-cleanup.md` (produced the current nine-section switcher — superseded by this design), `docs/articles/reviews/2026-05-25-docs-audience-review.mdx` (the audience analysis this design finally acts on).

## Problem

The docs serve three audiences — developers, the managers who pay, and investors — but are organized as one undifferentiated tree of ~400 published pages. The overlap between `concepts/` and `understanding/` was merged in navigation but never in content. `plan/` mixes active contracts, contributor runbooks, and dead history. The trial path a stranger actually takes was verified broken (no data-download command; the photon drop-in crashed cold). The prose reads machine-generated in places, and there is no enforced writing standard.

## Decisions (operator-approved)

1. **One site, three tracks.** Developers, managers, and investors share mailwoman.sister.software with distinct doors. No separate marketing site.
2. **Start over from scratch.** Every maintained page is written fresh. Old pages are raw material only.
3. **Lab notebook: keep only the best, rewritten for clarity.** Curated benchmark/eval material returns as fresh evidence pages. Raw dated records leave the published site (git history and unpublished repo directories keep them).
4. **Old links break.** No redirect infrastructure. The front page and search carry readers to the new material.
5. **Docs and CLI land together.** Where a documented path needs a missing or broken command (data download, planet build, drop-in serve), building or fixing the command is in scope. Every tutorial is executed end-to-end before it ships.
6. **Site shape: Ory-style top level.** Flat top nav of company-story doors; the four-part manual (Diátaxis) lives inside the Developers door. The existing DocsSubHeader section-switcher machinery provides per-door sub-navigation — no mega menu.
7. **Label notes:** the manager door was renamed away from "Why Mailwoman" (stutter next to the logo). The investor/trust door avoids the word "Company" (there is no company yet) — working label **About**; play with the word during drafting.

## Target structure

```
Mailwoman   Product | Solutions | Resources | Developers | About | Pricing   [Demo ▶] [GitHub]
```

~85 maintained pages replace ~400.

### Product (5)
Overview (one engine, one artifact) · Capabilities · Deployment options (library / server / browser / serverless / MCP) · Drop-in replacements · Data products. Landing pages, ≤ ~600 words, each hands off to a tutorial or reference page.

### Solutions (5) — the manager door, organized by pain
Cut the per-request bill · Own what you look up (storage rights) · Keep addresses inside your infrastructure · Fleet/telemetry reverse geocoding at volume · Resolve a messy customer file. Every page ends with the same two links: try it (tutorial) and what it costs (pricing).

### Resources (~10)
- **Field notes** — the existing blog, unchanged and not rewritten (dated record).
- **Benchmarks (~5)** — fresh evidence pages for our benchmark results: France/BAN, Belgium panel, outdoor/POI panel, plus the published losses. Each page links its committed harness; the governing sentence is "our numbers ship with the code to re-run them." Source material is provided at drafting time; committed pages carry only public methods, results, and harnesses.
- **Compare (~4)** — vs Google · vs Loqate/verification vendors · vs self-hosted Nominatim/Photon · vs Pelias/libpostal. Kind and factual; register rules below.

### Developers (~60 — the bulk)
- **Get started (3):** what Mailwoman is (for a developer) · install + first parse · the 10-minute trial.
- **Tutorials (8):** first parse → first geocode → CSV geocode → API server → drop-in swap → browser build → US dataset build → full planet build. Each carries `verified-with:` and is executed before shipping.
- **How-to guides (~15):** batch · record matching · validation · data freshness · serverless · Docker · MCP from an agent · Claude Code skill · messy input · PO boxes and edge kinds · autocomplete · reverse · annotations · confidence tuning · reporting a bug well.
- **Reference (~12):** library API · CLI (generated from command definitions) · HTTP APIs (native + three drop-ins, OpenAPI-backed) · component-tag schema · package directory · runtime flags · locales and tiers · footprints/system requirements.
- **Knowledge base (~20):** three shelves — Postal systems (~7), Geocoding (~6), Address intelligence (~7, the decoder explained analog-first).
- **Plus:** Status (what works today) · community and support · changelog (generated from releases).

### About (3)
Mission and open strategy (public-safe register) · security and compliance (privacy + SBOM + provenance + licensing rolled up) · contact.

### Deliberately absent
Case studies, webinars, whitepapers, customers/adopters, jobs. No faking the shape of a bigger organization; the slots exist to grow into.

## Writing system (the house style)

The writing system is **derived, not inherited**: it replaces all earlier voice guidance. Its authority is a selection from the standards in `scratchpad/writing-standards-draft.md` (ASD-STE100, Diátaxis, ISO 19100, UPU S42, RFC 7322, Microsoft, Google developer style, Ordnance Survey, USBGN), and the selection is justified by a documented comparison against contemporary geocoding and mapping documentation — Google Maps Platform, Mapbox, Geocode.earth, Jawg, Felt at minimum. The comparison asks, per contemporary: what register do they use per document type, what do they do that measurably helps a reader, what do they do that we refuse. The resulting choices are codified in `docs/engineering/writing-system.md` (with the comparison record) and encoded into the Vale rules and page templates before any content page is drafted.

Working hypothesis the derivation tests (not a foregone conclusion):

- **Diátaxis** classifies every page: `tutorial`, `guide` (how-to), `reference`, `explanation`, plus `landing` (Product/Solutions/About) and `evidence` (benchmarks). One page, one role, declared in frontmatter and enforced in CI.
- **Register per role.** Tutorials and how-to guides use the conversational-colleague voice ("Let's say you have a CSV of customer addresses…") — second person, starts-and-destinations, every paragraph moves the reader toward their goal. Reference pages use the controlled register (STE100-derived): one instruction per sentence, active voice, no rhetorical language, one term per concept. Explanations sit between: plain narrative prose, analog-first (rule-world concept before the statistical term), no hype. Landing pages: short declarative claims, every number earned.
- **Terminology.** One canonical term per concept, seeded from UPU S42 / ISO 19100 where they match the codebase's contract vocabulary (delivery point, postcode, address component, coordinate reference system…). The glossary (327 terms) is the term registry; new docs link terms rather than redefine them.
- **Mechanical enforcement: Vale.** `.vale.ini` + a Mailwoman style package in-repo. Rules: the banned-word list (actually, basically, simply, obviously, robust, seamless, comprehensive, leverage, various, numerous…), the "honest/genuine/actual" cluster, anthropomorphism (the parser "thinks"), weasel quantities (nearby, many, fairly) outside deliberately qualitative prose, contrastive-negation stock phrases ("not just X, it's Y"), heading case, canonical-term substitutions. Vale runs in the docs CI job on changed files; the whole new corpus lints clean at launch.
- **De-slop pass.** Every drafted page is audited for machine-writing tells (inflated symbolism, rule-of-three padding, vague attribution, filler phrases) before review. Numbers appear only with a source; claims a reviewer could not check do not ship.
- **Frontmatter contract:** `role` (required, enum above) · `audience` (required on landing/solution pages) · `verified-with` (required on tutorial/guide — the version the examples ran against) · `source-of-truth` (required on reference — the code path or generator that owns the contract). The structure gate script is rewritten to enforce this on every published page (no more thin 28-of-458 coverage).

### Register rules for competitive and strategy content (house rules, binding)

- No rude or abrasive material anywhere in the public output. No named call-outs, no accusations. We write about a community of peers. Named individuals never appear in comparative or strategic material.
- No named villains, no bitterness on any public surface. The product is the argument. Organizations and products are named only in neutral, factual comparison with dated public citations; another vendor's customers are never quoted or referenced; benchmarks against public services (BAN/Addok) are framed as complementary, never adversarial.
- Competitor prose is kind and factual; prices and claims carry dated public citations or do not appear.
- Business and personal details that are not already published stay unpublished.
- Accuracy claims ship with re-runnable harnesses; losses are published next to wins.
- Data-refresh cadence: docs state the committed truth, currently *no cadence committed*.

## Mechanics

- **Docusaurus:** keep the single docs plugin instance; the content tree under `docs/articles/` is replaced wholesale by the new tree. Top nav becomes the six doors + Demo CTA + GitHub. `DocsSubHeader` sections/sidebars are regenerated for the new doors (`sections.ts` and `sidebars.ts` move together in every PR). Front page (`src/pages/index.tsx`) rewritten to fork by audience. Footer rebuilt.
- **Publicness by construction.** The path-shaped build-exclusion globs are retired. `docs/articles/` contains only publishable pages. Internal material moves out of the published tree entirely:
  - Active internal contracts and runbooks (`plan/SCOPE`, `plan/reference/*` incl. SCHEMA, layer-contract, poi-layer-runbook, `CONTRIBUTING_MODEL_WORK`, operations docs) → `docs/engineering/` (in-repo, unpublished). AGENTS.md and memory pointers updated. These serve repo contributors, not site readers; the site's Contributing page points at GitHub.
  - Raw evals, retrospectives, reviews, phase plans, dated specs → `docs/records/` (in-repo, unpublished) or deleted where git history suffices. The eval ledger (`evals/scores-by-version.json`) stays at repo root, untouched.
- **Structure gate** (`docs/scripts/check-docs-structure.ts`): rewritten for the new frontmatter contract; orphan detection and duplicate-title checks retained; the role-required allowlist becomes "every page," not eight named paths.
- **Search:** Algolia index re-crawls after deploy; accept the stale-window. No redirects (decision 4); `documentation-map`'s URL-stability promise disappears with the page.
- **Demo pipeline untouched:** the demo-assets plugin, webpack aliases, R2 asset loading, and the demo page itself are out of scope except for nav/link updates.
- **Field notes:** blog instance untouched.

## CLI workstream (in scope, docs-driven)

The tutorials define the contract; the commands make the tutorials true:

1. **Data acquisition:** a documented, verified download path for the datasets each tutorial needs (working name `mailwoman data pull <bundle>`; exact shape decided in the plan after surveying the existing gazetteer/coverage CLI surface). Includes the resolver database the drop-in servers need.
2. **Drop-in serve paths:** `npx @mailwoman/photon serve` (and siblings) must start cold from a documented command sequence — cold-start testing found this broken.
3. **Planet build:** the full-planet and per-country build tutorials execute end-to-end on the lab host; footprints and durations recorded in the pages as measured numbers.
4. **Claude Code skill:** a shipped skill for agentic-coding users (install documented in a how-to; shape decided in the plan — repo `skills/` directory published with the package, plus the how-to page).

## Acceptance

- A stranger's 10-minute trial passes cold on a clean machine: install → first parse → first geocode, exactly as the Get-started pages state.
- The US-dataset and planet-build tutorials have been executed as written; their pages carry measured numbers.
- `yarn workspace @mailwoman/docs build` green (broken links/anchors throw); structure gate green under the new contract; Vale clean over the whole new corpus.
- No internal material is published: `docs/articles/` contains only the new tree; engineering/records trees live outside the content root.
- Each audience reaches its door from the front page in one click; every Solutions page ends at try-it + pricing.
- The three drop-in serve commands start cold as documented.

## Non-goals

- No redirects; no CMS or platform migration; no rewriting Field notes; no fake social proof; no model/schema changes to suit prose; no demo rework.
