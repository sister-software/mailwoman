# Mailwoman writing system

## Why this exists

Every published Mailwoman page is written against this document, and every rewrite task carries it as
required reading alongside the template for the page's role. It exists so that an 85-page rewrite has one
settled answer to register, terminology and structure instead of 85 improvised ones. The derivation is
recorded below so a later editor can reopen a decision against the evidence rather than against taste.

## Comparison record

Five geocoding and mapping documentation sets were surveyed on 2026-08-03 against a fixed rubric: document
types offered, register per type, how limits and failures are admitted, terminology discipline, and
code-example conventions. The surveys are read-only observations of public pages. Findings are compressed
here; the full reports live beside the plan in `.superpowers/sdd/2026-08-03-docs-reorg/field-survey-*.md`.

### Google Maps Platform

[developers.google.com/maps](https://developers.google.com/maps) splits the Geocoding API into four tabs —
Developer Guides v4, Developer Guides v3, Reference, Resources — with marketing held one level up at the
platform root. Guides use second person ("You access the Geocoding API through an HTTP interface",
[start](https://developers.google.com/maps/documentation/geocoding/guides-v3/start)); reference drops
contractions and states obligations directly ("You must specify either `address` or `components` or both in
a request",
[requests-geocoding](https://developers.google.com/maps/documentation/geocoding/guides-v3/requests-geocoding)).
Status codes are a closed enumerable table, one line each, which makes a status string matchable without
reading prose.

Take: version forks that stay side-by-side with a migration pointer; errors as a closed set. Refuse: the
same product carrying two names by page ("v3" in one nav, "Legacy products" in another); an error entry that
restates its own name and stops (`UNKNOWN_ERROR`, "could not be processed due to a server error"); cost
facts split across a doc page, a calculator and a console with no single worked total.

### Mapbox

[docs.mapbox.com](https://docs.mapbox.com) splits by URL prefix: `/api/*` reference, `/help/dive-deeper/*`
explanation, `/help/glossary/*` one term per page, `/help/getting-started/*` and `/help/tutorials/*` task
content, `/playground/*` interactive. Pricing is never inline in technical docs. Reference prose is
table-bound and terse; the response vocabulary (`feature`, `properties`, `relevance`, `spatial hierarchy`)
holds across reference, explanation and glossary with no synonym drift.

Take: a full literal JSON response beside every reference request, so a reader can diff their own output
against a known-good shape; a term registry cross-linked from first use; a playground that hits the live API
with the documented parameters. Refuse: curl-only at the reference layer, which taxes every non-shell
reader; code fragments with no output and no full-file context; a glossary that fragments one concept into
recursive one-sentence hops, so understanding "geocoding" requires opening "latitude and longitude" mid-read.

### Geocode Earth

[geocode.earth/docs](https://geocode.earth/docs/) runs one flat sidebar of roughly 25 pages, with pricing,
attribution and terms kept structurally outside the docs tree. Reference is plain declarative; guides are
warmer and first-person plural; the blog carries the most personality. Limits state their mechanism, not
only their number: per-second rate limits exist "to protect our servers from momentary spikes in requests"
and are "strictly enforced and are not averaged over multiple seconds"
([rate limits](https://geocode.earth/docs/intro/rate_limits/)). The authentication page names its own
security gap and then admits it withholds the mitigation.

Take: mechanism-first caveats with numbered thresholds a reader can compute against; curl first, then
per-language tabs against the identical URL; legal and business content as siblings of the docs tree rather
than nodes inside it. Refuse: no term registry despite an overloaded multi-word concept (match quality is
real, used across five endpoint pages, and never named once); inconsistent compounding of a term used
constantly; one flat sidebar for both read-once and look-up-repeatedly content, which survives at 25 pages
and does not survive at 85.

### Jawg Maps

[jawg.io/docs](https://www.jawg.io/docs) separates an API reference tree from an integration/SDK tree, with
marketing on its own property. Snippets are full standalone HTML documents rather than fragments, and
placeholders carry an inline replace-me comment (`// Don't forget to replace <YOUR_ACCESS_TOKEN> ...`,
[simple map](https://www.jawg.io/docs/integration/maplibre-gl-js/simple-map/)). The Places overview explains
one real URL with a labeled anatomy diagram instead of a paragraph, and the error table pairs an HTTP status
with a stable message-code string.

Take: a reading-time estimate at the top of each guide; the URL-anatomy diagram; an error table whose codes
are grep targets. Refuse: an attribution block repeated byte-identically across every SDK page; a typo
inside a shipped JSON example (`souce_id`), which propagates into the reader's own type definitions where a
prose typo would not; the full site-tree sidebar rendered on every page regardless of where a reader landed.

### Felt

Felt runs three separately-branded properties: [help.felt.com](https://help.felt.com) for map-making tasks,
[developers.felt.com](https://developers.felt.com) for the REST and SDK reference, and felt.com/blog. The
split means a GIS analyst troubleshooting a shapefile upload never reads code-flavored prose unless they
click through. Limits arrive as ceiling plus next action in one sentence pair ("up to 10,000 addresses per
upload. If you need a higher limit, contact sales"), and hard constraints are stated ahead of the procedure
they would break: [wms-wmts](https://help.felt.com/data-sources/cloud-sources/wms-wmts) says HTTP is
unsupported before its six-step connect walkthrough, not partway through it.

Take: caveats that carry a door as well as a wall; a small reused noun chain (source → layer → map) taught
in the same words on every page that touches it; constraints before steps. Refuse: bare FAQ-fragment
answers ("Not right now.") lifted into flowing prose, where the warmth depends on the Q&A widget shape; a
quoted customer's voice blended into house voice with no typographic separation; terminology held together
by repetition alone, which forces the same distinction to be re-taught on three pages.

### What all five agree on

All five use second person in task content, keep humor out of reference entirely, and hold marketing
structurally apart from technical docs. None of them runs a controlled dictionary, which is the finding that
decides the ASD-STE100 row below.

## Selection matrix

Nine standards were assessed. The verdict column is binding.

| Standard                                                                          | Verdict                          | Scope taken                                                                                    | Grounding                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Diátaxis](https://diataxis.fr/)                                                  | Adopt, structural                | Page-role split; one purpose per page                                                          | Already the six-role frontmatter contract (four Diátaxis roles plus `landing` and `evidence`). Geocode Earth's flat sidebar mixing read-once with look-up-repeatedly survives only at roughly 25 pages.                                            |
| [ASD-STE100](https://asd-ste100.org/)                                             | Adapt, reference register only   | One instruction per sentence, active voice, one word one meaning, no rhetorical language       | Applied to `reference` pages. The controlled dictionary is rejected: it cannot carry geo and ML vocabulary, and no surveyed contemporary uses one. Tutorials and guides are exempt; flattening them would discard the field's best warm registers. |
| [ISO 19100](https://www.iso.org/committee/54904.html)                             | Adapt, terminology seed only     | An ISO term where it is already the natural codebase term, such as coordinate reference system | The field speaks GeoJSON (`feature`, `properties`, `geometry` at both Mapbox and Geocode Earth), which is also the wire reality here. No wholesale adoption.                                                                                       |
| [UPU S42](https://www.upu.int/)                                                   | Adapt, postal shelf terminology  | Postal component vocabulary: delivery point, postcode, address component                       | Used in the postal shelf and codex-adjacent reference. Plain language on first mention, then the term.                                                                                                                                             |
| [RFC 7322](https://www.rfc-editor.org/rfc/rfc7322)                                | Adopt, organization principles   | Facts separated from rationale, stable section hierarchy, consistent terminology               | Contract first, rationale after. This is the ordering that lets a reference page be skimmed by a reader who already knows why.                                                                                                                     |
| [Microsoft Writing Style Guide](https://learn.microsoft.com/style-guide/)         | Adopt, primary style base        | Sentence-case headings, second person, contractions in guides, bias-free language              | Tie-breaker for anything the rules above leave open. It matches the observed field register across all five surveys.                                                                                                                               |
| [Google developer style](https://developers.google.com/style)                     | Adapt, API-reference conventions | Placeholder style, code formatting, HTTP-reference patterns                                    | Secondary to Microsoft, consulted where Microsoft is silent.                                                                                                                                                                                       |
| [Ordnance Survey](https://www.ordnancesurvey.co.uk/)                              | Reject as style authority        | GB place-name spellings only                                                                   | A lookup resource, not a register.                                                                                                                                                                                                                 |
| [US Board on Geographic Names](https://www.usgs.gov/us-board-on-geographic-names) | Reject as style authority        | US place-name spellings only                                                                   | A lookup resource, not a register.                                                                                                                                                                                                                 |

Two notes on the adapted rows. STE100's value here is its sentence discipline, and that discipline costs a
tutorial its warmth, so the adaptation is scoped by role rather than applied to the site. ISO 19100 is a
terminology seed and not a vocabulary: reach for an ISO term when the codebase already uses it, and reach
for the GeoJSON term when the wire format already uses it.

## Register by role

The six roles are the ones the frontmatter contract enforces
(`docs/scripts/docs-frontmatter-contract.ts`). Register is a property of the role, not of the author.

| Role          | Person                 | Contractions | Sentence length    | Examples                                    |
| ------------- | ---------------------- | ------------ | ------------------ | ------------------------------------------- |
| `tutorial`    | Second                 | Allowed      | Short to medium    | Every command executed, real output shown   |
| `guide`       | Second                 | Allowed      | Short to medium    | Executed, output shown when it is the proof |
| `reference`   | Second, declarative    | No           | Short, table-bound | Generated or executed, never hand-typed     |
| `explanation` | Second or plural first | Allowed      | Longer permitted   | Illustrative, marked as such                |
| `landing`     | Second                 | Allowed      | Short declaratives | One example at most                         |
| `evidence`    | Plural first           | Allowed      | Medium             | Numbers with the command that produced them |

**`tutorial`.** Present tense. Scenario openers are allowed ("Let's say you have a CSV of customer
addresses…"). Every superlative is cashed out by a checkable action in the same breath. Hard constraints go
before the steps that would hit them, not inside them. A caveat states the ceiling and the next action in
one sentence pair. Put a reading-time estimate at the top. Run every command and paste the real output.

**`guide`.** Same warmth, no scenario storytelling. State the outcome first, then a prerequisites block,
then the steps. No marketing language.

**`reference`.** Controlled register: declarative, no contractions, no humor, tables in place of prose.
Errors and statuses form one closed table with a stable grep-able code, a one-line meaning, and retry or
next-step guidance; an entry that restates its own name is decoration. Show the full request and the full
literal response together. On HTTP surfaces, curl first, then language tabs, every tab hitting the identical
endpoint. On library surfaces, full-file runnable examples with their output or rendered result, not
fragments. Placeholders use `<CAPS_PLACEHOLDER>` with an inline replace-me comment. Give the HTTP API
reference one URL-anatomy diagram. Facts before rationale.

**`explanation`.** Plain narrative, analog first: name the rule-world concept before the statistical one.
Define a term at first use in one sentence, then link it. Longer sentences are permitted. Zero hype.

**`landing`.** Short declaratives. Every number sourced. Superlatives only when cashed out. One
call-to-action per page. On a pricing page, one worked cost example rather than three correct facts a reader
has to assemble.

**`evidence`.** Method, then numbers, then losses, then a link to the run that produced them. First-person
plural is permitted. Caveats state their mechanism. Circularity caveats are mandatory: if the eval set and
the training set share a source, say so in the same section as the number.

## House rules

1. **One term per concept, registry-anchored.** `API key` is the term for a credential; `data layer` is two
   words; `forward geocoding` and `reverse geocoding` are the only direction terms.
2. **No boilerplate repeated verbatim across pages.** Shared content lives on one page and is linked. A
   reader comparing two pages should find them different where the subjects differ.
3. **Code examples use real places.** London, or an address from the test corpus. Never lorem placeholders.
   Examples on `reference` pages are generated or executed, because a typo inside copy-pasteable code
   propagates into the reader's own code where a prose typo would not.
4. **Admissions take the flat-fact plus next-step form.** No bare FAQ fragments in flowing prose.
5. **Quoted third-party voice is typographically separated from house voice.** A reader must be able to tell
   whose claim they are evaluating.
6. **Version forks stay navigable side by side** with one migration pointer, and the old version keeps one
   name in every nav and on every page.
7. **Marketing and legal content stay outside the technical tree**, as siblings rather than nodes inside it.
8. **Do not anthropomorphize the system.** A parser assigns scores, returns spans, or emits components. Say
   which.

## Terminology policy

`docs/glossary/glossary.json` is the term registry: 327 terms, each with a definition, tags, aliases and
related terms. A remark plugin auto-links occurrences in published pages, guarded against proper-noun false
positives (`docs/plugins/glossary/remark.ts`), so a term does not need a manual link to acquire a tooltip.

**Define, then link.** On first use in a page, define the term in one sentence in the running prose, and let
the registry link carry the depth. Do not send a first-time reader to the registry mid-sentence for the
concept the page is about — that is the recursive-hop failure the Mapbox survey records. Do not re-derive a
definition on the third page that needs it either; that is the repetition cost the Felt survey records. One
sentence locally, the registry for the rest.

**Adding a term.** A concept used on two or more pages earns a registry entry. Add it to
`glossary/glossary.json` with its aliases, so the drift spellings resolve to one tooltip rather than to
nothing.

### Canonical terms

| Concept                                  | Use                  | Do not use                      |
| ---------------------------------------- | -------------------- | ------------------------------- |
| Credential for an HTTP surface           | `API key`            | `access token`                  |
| Address to coordinate, the process       | `forward geocoding`  | `text search`, `address lookup` |
| Coordinate to address, the process       | `reverse geocoding`  | `coordinate lookup`             |
| A styled, queryable data source on a map | `data layer`         | `datalayer`, `data-layer`       |
| US five-digit postal identifier          | `ZIP Code`           | `zip code`, `zipcode`           |
| Non-US postal identifier                 | `postcode`           | `postal code`                   |
| Gazetteer project                        | `Who's On First`     | `whos on first`                 |
| Address to coordinate, the verb          | `geocode`            | `geo-code`                      |
| Coordinate pair                          | `latitude/longitude` | `lat/long`, `lat-long`          |

### Numbers and measurement

State the measured quantity. `23 m`, `14 parcels`, `95% confidence`, `27,405 ms → 175 ms on 8 MB`. If a
claim rests on a magnitude, the magnitude belongs in the sentence, and a magnitude never carries its own
absence: zero coverage and unmeasured coverage are different claims and read the same, so distinguish them
in words. Hedge quantities are permitted only where the sentence is deliberately qualitative, and Vale
flags each one so the choice is visible in review.

### Geospatial and postal vocabulary

For spatial relationships, prefer the topological predicate over the narrative description: `contains`,
`intersects`, `overlaps`, `within`, `adjacent to`. For postal components, prefer the UPU S42 vocabulary:
delivery point, carrier route, processing center, address component. Introduce a postal term in plain
language on first mention, then use the term.

## Machine-writing tells: the pre-commit audit

Run this checklist over a page before committing it. It catches what a linter cannot: the tells are
structural, and a rule that matched them would also match correct prose.

1. **Inflated symbolism.** A sentence that assigns importance instead of stating a fact. Fix: state the
   fact, and let the reader judge its weight.
2. **Rule-of-three padding.** Two short clauses then a longer one, or three adjectives where the third
   restates the first two. Fix: keep the one precise descriptor.
3. **Vague attribution.** "Developers find", "it is widely considered". Fix: name who, or cut the sentence.
4. **Filler intensifiers.** Words that prop up a claim the evidence does not carry. Vale catches the common
   ones; the pattern is the target, not the token list.
5. **Contrastive negation.** Introducing a topic by what it is not, especially when nobody proposed the
   negated thing. Fix: state the positive claim.
6. **Manufactured cadence.** Strings of clipped sentences, or a paragraph ending on a quotable line rather
   than an informative one. Fix: end on the sentence that carries information.
7. **Superficial participial analysis.** A trailing "-ing" clause that narrates rather than explains
   ("reflecting the system's flexibility"). Fix: cut it, or replace it with the mechanism.
8. **Uniform paragraph shape.** Every paragraph the same length, topic sentence plus three supports plus a
   kicker. Fix: let a short thought be one line.
9. **Restatement.** The same point in a heading, the first sentence, and a summary box. Fix: keep one.
10. **Expansion.** A draft that is longer than the facts require. Fix: cut. This is the most reliable
    single improvement available to any draft on this list.

Two habits sit under the checklist. Rewrite the thought rather than swapping the flagged word, because a
synonym leaves the structure that produced the tell. And prefer cutting to rewording: a sentence that adds
rhythm and no information should go.

## How Vale enforces the mechanical subset

Vale checks the token-level subset of these rules. Everything structural — role, section order, example
discipline, the audit above — is enforced by review and by `docs/scripts/check-docs-structure.ts`, not by
Vale.

| Rule file                        | Enforces                                                                    | Severity |
| -------------------------------- | --------------------------------------------------------------------------- | -------- |
| `Mailwoman/Terms.yml`            | Canonical terms table above                                                 | error    |
| `Mailwoman/BannedWords.yml`      | Filler intensifiers, audit item 4                                           | error    |
| `Mailwoman/StockPhrases.yml`     | Contrastive negation and consultant-deck constructions, audit items 1 and 5 | error    |
| `Mailwoman/Anthropomorphism.yml` | House rule 8                                                                | warning  |
| `Mailwoman/Weasel.yml`           | Unmeasured hedge quantities, per Numbers and measurement                    | warning  |

Run it two ways:

```bash
# Lint the published pages.
yarn workspace @mailwoman/docs lint:prose

# Lint the rules themselves against their fixtures.
yarn workspace @mailwoman/docs lint:prose:fixtures
```

The full-corpus run is not green and is not expected to be: as of 2026-08-03 it reports 1355 errors and 237
warnings across 458 files, because those pages predate these rules and are what the rewrite replaces. CI
therefore lints only the pages a pull request touches under `docs/articles/` and `docs/src/pages/`; the
fixture check runs unconditionally. The full-corpus run becomes the gate once the rewrite lands.

Inline code spans and fenced code blocks are excluded from linting, so a banned token can be named in
backticks — which is how the canonical terms table above states the spellings it forbids. Frontmatter is
stripped before linting, so a `source-of-truth:` key is not read as prose.

Adding a rule means adding a fixture. `docs/scripts/vale-fixtures/dirty.md` carries one hit per token and
`clean.md` must stay at zero alerts; `docs/scripts/check-vale-rules.sh` asserts both, plus a minimum error
count and at least one hit from every rule file, and it runs in the docs CI job. That script also carries one
negative assertion: `full-text search` in plain prose must stay quiet, because the `text search` swap is
guarded so the FTS vocabulary this repo ships survives the rule.

## Templates

One per role, in [`page-templates/`](./page-templates/): [tutorial](./page-templates/tutorial.md),
[how-to](./page-templates/how-to.md), [reference](./page-templates/reference.md),
[explanation](./page-templates/explanation.md), [landing](./page-templates/landing.md),
[evidence](./page-templates/evidence.md). Each carries a frontmatter skeleton that satisfies the contract in
`docs/scripts/docs-frontmatter-contract.ts`, the section order for its role, the opening move, and one
exemplar paragraph in this voice. Start a new page by copying the template for its role, not by copying a
neighbouring page.
