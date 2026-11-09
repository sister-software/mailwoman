# Proposed public information architecture

This is a clean-sheet navigation and page contract for [issue #2979](https://github.com/sister-software/mailwoman/issues/2979). The current `docs/articles/` tree contains 82 MDX article pages. The proposal below names destinations by reader need. The old article count does not set a target page count. Destination IDs are stable planning keys used by `page-briefs.md` and `source-to-target.md`. Publication will create these routes after review.

## Editorial rule

Diátaxis separates learning, work, lookup, and understanding. A tutorial leads a learner through a reliable experience. A how-to guide helps a reader achieve a real task. Reference states the current interface and its limits. Explanation connects causes and concepts. Mailwoman also needs landing pages for selection and evidence pages for dated measurements, as `docs/engineering/writing-system.md` specifies. The Good Docs templates supply useful prompts for prerequisites, expected output, verification, and related material. Authors should adapt those prompts to the page's job and remove template boilerplate.

## Site map

| Destination ID | Proposed route                              | Role        | Reader question or result                                                                  |
| -------------- | ------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------ |
| P01            | `/product`                                  | landing     | What does Mailwoman provide today?                                                         |
| P02            | `/product/capabilities`                     | landing     | Which operations can I use, and which data does each require?                              |
| P03            | `/product/deployment`                       | landing     | Which runtime shape fits my constraints?                                                   |
| P04            | `/product/data-and-licensing`               | landing     | What data, license, attribution, and provenance obligations apply?                         |
| P05            | `/product/limits-and-status`                | landing     | Which capabilities and locale/data tiers are published, buildable, or unverified?          |
| P06            | `/solutions`                                | landing     | Which stated use cases match my problem?                                                   |
| D01            | `/docs/start`                               | tutorial    | Install the library and inspect a first parse.                                             |
| D02            | `/docs/tutorials/geocode-a-file`            | tutorial    | Learn parsing, local data, coordinate provenance, and unresolved rows through a small CSV. |
| D03            | `/docs/tutorials/run-a-server`              | tutorial    | Learn the native HTTP surface by starting and querying a local server.                     |
| D04            | `/docs/tutorials/inspect-a-parse`           | tutorial    | Learn spans, tags, confidence, and trace output through one result.                        |
| D05            | `/docs/guides/batch-geocode`                | guide       | Batch geocode records with explicit unresolved rows.                                       |
| D06            | `/docs/guides/add-autocomplete`             | guide       | Add autocomplete to an application.                                                        |
| D07            | `/docs/guides/operate-data`                 | guide       | Download, inspect, refresh, migrate, and roll back local data.                             |
| D08            | `/docs/guides/deploy`                       | guide       | Deploy a supported service form with measured resource needs.                              |
| D09            | `/docs/guides/use-a-compatible-http-client` | guide       | Connect an existing Nominatim, Photon, or libpostal client to a supported surface.         |
| D10            | `/docs/guides/handle-results`               | guide       | Handle messy input, edge address kinds, and confidence thresholds.                         |
| D11            | `/docs/guides/report-a-problem`             | guide       | Capture a reproducible parser or security report and send it to the right place.           |
| D12            | `/docs/guides/validate-records`             | guide       | Apply a stated completeness and postal-shape policy to parsed records.                     |
| D13            | `/docs/guides/match-records`                | guide       | Match candidate address records and review uncertain pairs.                                |
| D14            | `/docs/guides/reverse-geocode`              | guide       | Resolve a coordinate and interpret containment.                                            |
| D15            | `/docs/guides/use-mcp`                      | guide       | Configure and check the MCP server in a client.                                            |
| D16            | `/docs/guides/parse-in-browser`             | guide       | Load model assets and parse in a browser application.                                      |
| D17            | `/docs/guides/annotate-results`             | guide       | Apply annotators and choose an output projection.                                          |
| D18            | `/docs/guides/install-coding-skill`         | guide       | Install and update the code-assistant skill.                                               |
| R01            | `/docs/reference/library`                   | reference   | Library imports, signatures, options, returns, and errors.                                 |
| R02            | `/docs/reference/cli`                       | reference   | Commands, flags, exit codes, and generated command output.                                 |
| R03            | `/docs/reference/http`                      | reference   | Native and compatibility endpoints, request/response shapes, and errors.                   |
| R04            | `/docs/reference/schema`                    | reference   | Component tags, spans, result fields, kinds, tiers, and provenance.                        |
| R05            | `/docs/reference/packages-and-runtime`      | reference   | Published packages, runtime flags, footprints, and compatibility.                          |
| R06            | `/docs/reference/data-and-locales`          | reference   | Data bundles, locale support, layer availability, and prerequisites.                       |
| E01            | `/docs/explanation/address-systems`         | explanation | Why worldwide addresses resist one format and one validation rule.                         |
| E02            | `/docs/explanation/parsing`                 | explanation | How tokens, labels, decoder constraints, and gazetteer priors interact.                    |
| E03            | `/docs/explanation/geocoding`               | explanation | How geocoding sources and precision tiers affect a coordinate.                             |
| E04            | `/docs/explanation/confidence-and-limits`   | explanation | What confidence, ambiguity, and abstention mean for use decisions.                         |
| E05            | `/docs/explanation/data-and-model-quality`  | explanation | How corpus provenance, holdouts, and release evaluation support claims.                    |
| V01            | `/evidence/benchmarks`                      | evidence    | Dated benchmark index and how to read the metrics.                                         |
| V02            | `/evidence/geocoding-panels`                | evidence    | Reproducible country/panel measurements with losses and caveats.                           |
| V03            | `/evidence/comparisons`                     | evidence    | Dated, scoped alternatives and runnable comparison method.                                 |
| A01            | `/about`                                    | landing     | Mission, contact, support, and security route.                                             |

This first architecture proposes 39 destinations: 6 product/solution landing pages + 18 learning/work pages + 6 reference pages + 5 explanation pages + 3 evidence pages + 1 about page = 39. These are proposed destinations, with no publication quota.

## Navigation and cross-links

The primary navigation offers Product, Solutions, Docs, Evidence, and About. Docs opens with `D01` and shows four labeled groups: Tutorials, Guides, Reference, and Explanation. Search results should expose role and version so a reader can distinguish a learning path from a command lookup. A tutorial links to the relevant guide, reference, and explanation after the concrete exercise. Guides link to exact reference entries beside the step that needs them. Reference links to guides for tasks, while its own body remains factual.

Product pages link to `P05` for current availability and to `V01` for measured claims. Solution pages link to a runnable guide and the relevant limitations. Evidence pages state artifact version, dataset/provenance, command, denominator, comparison arm, and losses. The engineering records and research posts remain separate dated material. Current docs may cite them with dates.

## Route and publication rules

Every existing article URL needs an explicit redirect or an intentional `410 Gone` decision. The route ledger in `source-to-target.md` proposes redirect targets and records old section destinations. A redirect can land at the target page's relevant anchor when the section exists. Otherwise it lands at a page that answers the original question. Maintain old anchors or add anchor-level redirects for externally linked headings after inspecting traffic and inbound links. No page should redirect to a generic index solely because its old content was mixed.

Before publishing, verify the new route against Docusaurus configuration, confirm the destination exists, and run a link checker on all internal and old-route links. Publish redirects in the same release as their replacement pages. Retired material that is historical or unsupported keeps a dated archive route or a specific retirement explanation, depending on whether the old URL has continuing value.
