# Country groupings and interactive reference tables

Status: draft for operator review, 2026-11-24.

## Intent

A coverage reader should be able to ask how much of a grouping of countries this repository covers: the G7, the
G20, the EU, the OECD, a trade bloc, or a classification such as the IMF advanced economies. This work adds dated
groupings to `@mailwoman/registry` and publishes the coverage table on the documentation site, where every large
markdown table can be sorted and filtered.

## Decisions

- **Membership sources (approach A).** Organization memberships come from Wikidata "member of" (P463) statements
  with their start, end and role qualifiers, pinned like the existing ISO 3166 query. A grouping Wikidata models
  another way uses that property: the eurozone is Q8268 "has part(s)" (P527). Classifications come from their
  publishers' own lists: the IMF World Economic Outlook groups and the World Bank income groups. A membership list is
  a list of facts, so the registry takes the facts from any publisher.
- **Interactive tables (approach 1).** `docs/src/theme/MDXComponents.tsx` maps `table` to one component. It renders
  the same markup on the server. In the browser it adds TanStack Table sorting and a text filter to tables with at
  least 10 body rows. A column whose non-empty cells all parse as numbers, after removing thousands separators and
  a trailing unit word, sorts numerically when more than half of its non-blank cells are numbers.
- **Publication.** The coverage generator writes `docs/articles/reference/coverage.mdx`, route R07
  `/docs/reference/coverage` under #2982. The copy at `docs/engineering/reference/jurisdiction-coverage.mdx` is
  removed. The page adds one row per grouping: members on the census date and the count of those members with corpus
  rows, admission, gazetteer places, a board row and a support promise. The support-promise column counts any
  promise in `promises.json` for the country.

## Rules a builder can't infer

- Every membership has a start and an end, each a date or `null`, and every query takes a date. A `null` start is
  unknown, and a member with one is marked `startUnknown`.
- A statement's role decides membership: a `member` counts, while associates, observers and suspended members are
  recorded and excluded. Wikidata's stated counts include such roles: the Andean Community states 9 members and has
  4 full members.
- A member's code is a registry country record of any status, including formerly used codes such as `SU`. A
  publisher's non-ISO code, such as the World Bank's `XKX` or `CHI`, is kept as the publisher spells it, with status
  `source-extension`, as airport countries are today. A Wikidata member with no alpha-2 claim, such as the item
  "Kingdom of Denmark", is reported in `coverage.json`. The normalizer never drops it without a report.
- A grouping whose statements the normalizer can't classify ships as `blocked`, and its queries throw with the
  statements that blocked it. It never reads as empty. The other groupings ship.
- `countriesOfGrouping(id, at, members)` in `@mailwoman/codex/country/sets` takes the members that
  `groupingMembers` returns, because the registry depends on core and core depends on codex. It returns the members
  codex can represent and lists the rest.

## Delivery

One pull request for #3447 holds the registry groupings, the codex constructor, the table component and the published
coverage page. A Wikidata defect the normalizer reports is listed in `coverage.json` for correction on Wikidata.
