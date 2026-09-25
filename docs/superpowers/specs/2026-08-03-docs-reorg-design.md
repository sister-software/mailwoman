# Docs reorganization — three audiences, fresh site — design

**Date:** 2026-08-03
**Status:** approved by the operator. The operator handed off the conversation after section 2, and sections 3–6 were settled under that approval.
**Predecessors:** `docs/superpowers/plans/2026-07-14-documentation-architecture-cleanup.md`, which produced the current nine-section switcher and is superseded by this design, and `docs/articles/reviews/2026-05-25-docs-audience-review.mdx`, the audience analysis this design acts on.

## Problem

The docs serve three audiences (developers, the managers who pay, and investors), but they are organized as one undifferentiated tree of ~400 published pages. `concepts/` and `understanding/` were merged in navigation, but their overlapping content was never merged. `plan/` mixes active interfaces, contributor runbooks, and obsolete history. We verified that the trial path a stranger takes is broken: there is no data-download command, and the photon drop-in crashed on a cold start. Some prose reads as machine-generated, and no writing standard is enforced.

## Decisions (operator-approved)

1. **One site, three tracks.** Developers, managers, and investors share mailwoman.ai, each with a distinct entry point. There is no separate marketing site.
2. **Start over from scratch.** Every maintained page is written fresh. Old pages serve only as raw material.
3. **Lab notebook: keep only the best material, rewritten for clarity.** Curated benchmark/eval material returns as fresh evidence pages. Raw dated records leave the published site, and git history and unpublished repo directories keep them.
4. **Old links break.** The site gets no redirect infrastructure. The front page and search lead readers to the new material.
5. **Docs and CLI land together.** Where a documented path needs a missing or broken command (data download, planet build, drop-in serve), building or fixing the command is in scope. Every tutorial is executed end-to-end before it ships.
6. **Site shape: Ory-style top level.** The flat top nav holds doors that tell the company story, and the four-part manual (Diátaxis) lives inside the Developers door. The existing DocsSubHeader section-switcher provides per-door sub-navigation, so the site needs no mega menu.
7. **Label notes:** the manager door is no longer called "Why Mailwoman", because the name stuttered next to the logo. The investor/trust door avoids the word "Company" because there is no company yet. Its working label is **About**, and drafting can try other words.

## Target structure

```
Mailwoman   Product | Solutions | Resources | Developers | About | Pricing   [Demo ▶] [GitHub]
```

~85 maintained pages replace ~400.

### Product (5)

Overview (one engine, one artifact) · Capabilities · Deployment options (library / server / browser / serverless / MCP) · Drop-in replacements · Data products. These are landing pages of ≤ ~600 words, and each one links onward to a tutorial or reference page.

### Solutions (5) — the manager door, organized by pain

Remove the per-request bill · Own what you look up (storage rights) · Keep addresses inside your infrastructure · Fleet/telemetry reverse geocoding at volume · Resolve a messy customer file. Every page ends with the same two links: try it (tutorial) and what it costs (pricing).

### Resources (~10)

- **Field notes**: the existing blog, kept unchanged as a dated record.
- **Benchmarks (~5)**: fresh evidence pages for our benchmark results (France/BAN, Belgium panel, outdoor/POI panel) and the published losses. Each page links its committed harness, following the principle "our numbers ship with the code to re-run them." Source material is provided at drafting time, and committed pages carry only public methods, results, and harnesses.
- **Compare (~4)**: vs Google · vs Loqate/verification vendors · vs self-hosted Nominatim/Photon · vs Pelias/libpostal. These pages are kind and factual and follow the register rules below.

### Developers (~60 — the bulk)

- **Get started (3):** what Mailwoman is (for a developer) · install + first parse · the 10-minute trial.
- **Tutorials (8):** first parse → first geocode → CSV geocode → API server → drop-in swap → browser build → US dataset build → full planet build. Each carries `verified-with:` and is executed before shipping.
- **How-to guides (~15):** batch · record matching · validation · data freshness · serverless · Docker · MCP from an agent · Claude Code skill · messy input · PO boxes and edge kinds · autocomplete · reverse · annotations · confidence tuning · reporting a bug well.
- **Reference (~12):** library API · CLI (generated from command definitions) · HTTP APIs (native + three drop-ins, OpenAPI-backed) · component-tag schema · package directory · runtime flags · locales and tiers · footprints/system requirements.
- **Knowledge base (~20):** three shelves: Postal systems (~7), Geocoding (~6), and Address intelligence (~7, which explains the decoder through non-statistical analogies first).
- **Plus:** Status (what works today) · community and support · changelog (generated from releases).

### About (3)

Mission and open strategy (public-safe register) · security and compliance (privacy + SBOM + provenance + licensing rolled up) · contact.

### Deliberately absent

Case studies, webinars, whitepapers, customers/adopters, and jobs. The site does not pretend to be a bigger organization, and these sections can be added as the project grows.

## Writing system (the house style)

The writing system is **derived rather than inherited**, and it replaces all earlier voice guidance. It selects from the standards in `scratchpad/writing-standards-draft.md` (ASD-STE100, Diátaxis, ISO 19100, UPU S42, RFC 7322, Microsoft, Google developer style, Ordnance Survey, USBGN). A documented comparison against contemporary geocoding and mapping documentation justifies the selection, covering at least Google Maps Platform, Mapbox, Geocode.earth, Jawg, and Felt. For each of these, the comparison asks three questions: which register they use for each document type, what they do that measurably helps a reader, and what they do that we reject. `docs/engineering/writing-system.md` records the resulting choices with the comparison, and the Vale rules and page templates encode them before any content page is drafted.

The derivation tests this working hypothesis and may overturn it:

- **Diátaxis** classifies every page as `tutorial`, `guide` (how-to), `reference`, or `explanation`, plus `landing` (Product/Solutions/About) and `evidence` (benchmarks). Each page has one role, declared in frontmatter and enforced in CI.
- **Register per role.** Tutorials and how-to guides use a conversational colleague's voice ("Let's say you have a CSV of customer addresses…"). They use the second person, state the start and destination, and make every paragraph move the reader toward the goal. Reference pages use the controlled register derived from STE100: one instruction per sentence, active voice, plain language, and one term per concept. Explanations sit between the two. They use plain narrative prose, introduce a non-statistical concept before the statistical term, and avoid hype. Landing pages make short declarative claims, and every number has a source.
- **Terminology.** Each concept has one canonical term, taken from UPU S42 / ISO 19100 where those match the codebase's interface vocabulary (delivery point, postcode, address component, coordinate reference system…). The glossary (327 terms) is the term registry, and new docs link to terms instead of redefining them.
- **Mechanical enforcement: Vale.** The repo holds `.vale.ini` and a Mailwoman style package. The rules cover filler and marketing intensifiers, the direct-word cluster, anthropomorphism (the parser "thinks"), weasel quantities outside deliberately qualitative prose, contrastive-negation stock phrases ("not X, it's Y"), heading case, and canonical-term substitutions. Vale runs on changed files in the docs CI job, and the whole new corpus passes Vale at launch.
- **Machine-writing audit.** Before review, every drafted page is checked for signs of machine writing (inflated symbolism, rule-of-three padding, vague attribution, filler phrases). Numbers appear only with a source, and claims a reviewer could not check do not ship.
- **Frontmatter interface:** `role` (required, enum above) · `audience` (required on landing/solution pages) · `verified-with` (required on tutorial/guide; the version the examples ran against) · `source-of-truth` (required on reference; the code path or generator that owns the interface). The structure check script is rewritten to enforce these fields on every published page, replacing today's coverage of only 28 of 458 pages.

### Register rules for competitive and strategy content (house rules, binding)

- The public output contains no rude or abrasive material, calls out nobody by name, and makes no accusations. We write about a community of peers. Named individuals never appear in comparative or strategic material.
- No public surface casts anyone as a villain or expresses bitterness. The product makes the argument. Organizations and products are named only in neutral, factual comparisons with dated public citations. Another vendor's customers are never quoted or referenced. Benchmarks against public services (BAN/Addok) are framed as complementary and never as adversarial.
- Competitor prose is kind and factual. Prices and claims appear only with dated public citations.
- Business and personal details that are not already published stay unpublished.
- Accuracy claims ship with re-runnable harnesses, and losses are published next to wins.
- Data-refresh cadence: the docs state what is committed, which is currently _no cadence committed_.

## Mechanics

- **Docusaurus:** keep the single docs plugin instance, and replace the content tree under `docs/articles/` wholesale with the new tree. The top nav becomes the six doors plus the Demo CTA and GitHub. `DocsSubHeader` sections and sidebars are regenerated for the new doors, and every PR changes `sections.ts` and `sidebars.ts` together. The front page (`src/pages/index.tsx`) is rewritten to branch by audience, and the footer is rebuilt.
- **Only publishable pages in the content tree.** The path-shaped build-exclusion globs are retired. `docs/articles/` contains only publishable pages, and internal material moves out of the published tree entirely:
  - Active internal interfaces and runbooks (`plan/SCOPE`, `plan/reference/*` incl. SCHEMA, layer-interface, poi-layer-runbook, `CONTRIBUTING_MODEL_WORK`, operations docs) move to `docs/engineering/`, which stays in the repo and unpublished. AGENTS.md and memory pointers are updated. These pages serve repo contributors rather than site readers, and the site's Contributing page points at GitHub.
  - Raw evals, retrospectives, reviews, phase plans, and dated specs move to `docs/records/` (in the repo, unpublished), or are deleted where git history is enough. The eval ledger (`evals/scores-by-version.json`) stays untouched at the repo root.
- **Structure check** (`docs/scripts/check-docs-structure.ts`): rewritten for the new frontmatter interface. It keeps orphan detection and duplicate-title checks, and the role-required allowlist expands from eight named paths to every page.
- **Search:** the Algolia index re-crawls after deploy, and we accept the window in which it is stale. The site has no redirects (decision 4), and the URL-stability promise on `documentation-map` disappears with that page.
- **Demo pipeline untouched:** the demo-assets plugin, webpack aliases, R2 asset loading, and the demo page itself are out of scope except for nav/link updates.
- **Field notes:** the blog instance stays untouched.

## CLI workstream (in scope, docs-driven)

The tutorials define the interface, and the commands are built or fixed until the tutorials work:

1. **Data acquisition:** a documented, verified download path for the datasets each tutorial needs, including the resolver database the drop-in servers need. The working name is `mailwoman data pull <bundle>`. The plan decides the exact shape after surveying the existing gazetteer/coverage CLI surface.
2. **Drop-in serve paths:** `npx @mailwoman/photon serve` and its siblings must start cold from a documented command sequence. Cold-start testing found this path broken.
3. **Planet build:** the full-planet and per-country build tutorials run end-to-end on the lab host, and the pages record the measured footprints and durations.
4. **Claude Code skill:** a shipped skill for agentic-coding users, with installation documented in a how-to. The plan decides the shape: a repo `skills/` directory published with the package, plus the how-to page.

## Acceptance

- A stranger's 10-minute trial passes cold on a clean machine: install → first parse → first geocode, exactly as the Get-started pages state.
- The US-dataset and planet-build tutorials have been executed as written, and their pages carry measured numbers.
- `yarn workspace @mailwoman/docs build` passes, with broken links and anchors raising errors. The structure check passes under the new interface, and Vale reports no errors across the whole new corpus.
- No internal material is published. `docs/articles/` contains only the new tree, and the engineering/records trees live outside the content root.
- Each audience reaches its door from the front page in one click, and every Solutions page ends with try-it and pricing links.
- The three drop-in serve commands start cold as documented.

## Non-goals

- Redirects, a CMS or platform migration, rewriting Field notes, fake social proof, model/schema changes made to suit the prose, and demo rework are all out of scope.
