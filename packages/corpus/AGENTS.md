# AGENTS.md — `@mailwoman/corpus`

Scope notes for the training-corpus pipeline. The repo-wide rules live in the root `AGENTS.md`; this
file covers what is specific to acquiring source data and turning it into recipe outputs, and it exists
because each item below cost a real investigation to establish.

## OpenAddresses acquisition

OA has **two** distribution endpoints with different access rules, and picking the wrong one either
blocks you on a credential or costs a multi-gigabyte download for a single county:

- **Country collections** — `batch.openaddresses.io`, reached by
  `mailwoman corpus fetch openaddresses --country <cc>`. Requires a free registered account;
  `fetchOpenAddresses` reads `OA_BATCH_TOKEN`. Granularity is a whole country, and the US collection is several gigabytes.
- **Per-source runs** — `https://results.openaddresses.io/latest/run/<path>.zip`, e.g.
  `.../latest/run/us/ia/statewide.zip`. **Anonymous access with no token**, and the endpoint honors range requests. `<path>`
  is exactly the member path the recipe names, so `oa-cache/us__ia__statewide.zip` ⇄
  `us/ia/statewide.csv` ⇄ `/latest/run/us/ia/statewide.zip`.

The auth check is on collections only. If you need a handful of specific sources, use the per-source
endpoint — all seven `us__*` sources the recipes read total ~117 MB.

`HEAD` against the per-source endpoint returns no `Content-Length` (it redirects). To size one
without downloading it, issue a one-byte range GET and read `Content-Range`.

## A file's mtime is not its data's vintage

`$MAILWOMAN_DATA_ROOT/openaddresses/europe.zip` has a 2021 mtime. That date reads as five-year-old data,
and the file has been proposed for refresh on that basis. It is not stale: `fr/countrywide.csv`,
`de/berlin.csv` and `de/sn/statewide.csv` are **byte-identical** to what OA's current run serves
(`bf624492…`, `9903d438…`, `623b099b…`). The date records when someone downloaded the archive.

Before proposing a source refresh — which changes recipe-output bytes and therefore lands in retrain
territory — `md5sum` the member against the current run. It costs one command and has already
prevented one retrain proposed over a file timestamp.

## The embedded-newline census

A CSV value may contain a newline (inside a quoted field). Whether any given source does is
a property of the DATA rather than of the code, so measure rather than argue:

```sh
unzip -p <zip> <csv> | awk '{n=gsub(/"/,"&"); if(n%2==1) odd++} END{print FILENAME, NR, odd+0}'
```

Full results are in `docs/superpowers/specs/2026-08-02-taste-audit-findings.md`. The short version:
of every source reachable on the lab host, only two contain any. `fr/countrywide.csv` has 1 record and
`us/ia/statewide.csv` has 12, all unit designators like `"#2\n#2"`. Everything else is zero.

The census has two consequences:

- **`readCSVRecords` collapses `\r\n` inside a value to a space**, and is deliberately scoped to
  `\r\n` rather than `\s`. The quote-blind splitter it replaced was acting as an accidental newline
  sanitizer — those IA records used to split in two and get dropped by the field checks. A collapse
  widened to `\s+` also rewrites `NORTH   MAIN STREET` on rows with no line break at all, silently
  changing values in every recipe output. `scaffold.test.ts` pins both directions.
- **Line-based pre-filters run before the parser and can split a record in half.** `po-box-cedex`'s
  `awk 'NR%211==3'` stride and the `head -n` caps elsewhere count physical lines. The parse cannot
  repair a record the pre-filter already split. A halved record fails the field checks and drops. This is a
  sampling artifact rather than a correctness bug, and it is documented at the call site. FR gets away with
  it by luck — neither physical line of its one multi-line record is `≡ 3 (mod 211)`.

## `spliterator` ≥ 5.0.0 is a hard floor

Do not re-introduce buffer windowing around `CSVSpliterator.from`. It existed because `searchMatches`
re-scanned the whole buffer per delimiter before 5.0.0 — quadratic, and the pathological input was
the ORDINARY one (a source with no quotes at all paid a full scan per row). Measured on a real OA
extract: 8 MB took 27,405 ms on 4.0.0 and 175 ms on 5.0.0. Streaming callers never saw it because
they were chunk-bounded. Only a whole-buffer `.from()` exposed it.

`normalizeKeys` follows the row mode in both entry points. The default object mode normalizes headers to lower-case
keys. A reader that indexes publisher spelling — for example OpenAddresses' `LON,LAT,NUMBER,STREET` — must set
`normalizeKeys: false`; `readCSVRecords` intentionally uses the normalized default.

## Before claiming a built recipe output needs rebuilding

Recipe outputs are build outputs under `$MAILWOMAN_DATA_ROOT/corpus/slices/` rather than committed
artifacts. Two checks, one command each, before asserting that a code change invalidates one:

1. **Is that reader on the changed path?** Several recipes read the same source through different
   readers. `locale.ts` has its own `CSVSpliterator` reader and is not among `readCSVRecords`' callers.
2. **Does the artifact predate the fix?** Compare the recipe output's mtime against the commit date of
   the change. A recipe output built after a fix already contains it.

When both checks were skipped once, the result was a claim that `synth-es-pedania-v1.jsonl` needed
re-pinning. Its reader had migrated on 2026-07-08 and the recipe output was built 2026-07-22. The work was
already done, and acting on the claim would have cost an 800,000-row rebuild to find that out.

## A recipe-output `source` is a wire identifier

A recipe's `source` string is stored on every row of every corpus that contains it, keyed by every
training config that weights it, and quoted by every model card trained on it. `lib/recipes/sources.ts`
records each one under its retired spelling (`synth-german`) and its current one (`rendered-de`),
with the file that writes it. The tail is kept byte-for-byte in every other entry, so the mapping is a
prefix swap. Germany is the exception because the retired name spelled a language word where every
other locale reads as an ISO code. Read that table before renaming a source, adding one, or reading an
archived corpus whose `source` column begins with `synth-`. The `wire-identifiers` repository-health check
refuses a config key that no adapter, recipe or retained overlay emits under either spelling. A corpus
assembled before 2026-09-26 stores the retired spelling, and the config that targets it keeps that
spelling, because the loader reads the corpus rather than the table.

## A new source joins the input table and the register before any build reads it

`data/corpus-source-inputs.json` maps every corpus source id to the register sources whose text reaches its
rows, with the `licenseID` each one points at. A derived or synthetic source lists every input, and a
publication with no register row gets one in `data/source-additions.json` under an `unchecked` decision, so
the gap shows in the register rather than hiding as an absence. Add both entries in the change that adds the
adapter, recipe, carried overlay or Python builder, before any build reads the source. The
`corpus-source-inputs` repository check reports an emitted source the table does not map.

`buildCorpus`, `corpus overlay-manifest`, `corpus slice`, every Python corpus builder, the `train` command
and the Modal launcher's local entry point refuse a source unless each register source it reads carries an
elected decision whose `operations` permit both `transform` and `train`. The refusal message states the
source, the register row and the missing permission. `--unshippable-reason <why>` (in a training config,
`data.unshippable_reason`) admits the source for a local experiment and records the output as not shippable
in its `source_rights` or `SOURCE_RIGHTS.json` record. An output it admits is always marked not shippable. A source that keeps
its id while its producer changes inputs records the earlier inputs under `history` with the corpora built
from them, as `spliced-sub-venue` does for its Price Paid Data skeletons (#2635, #2643).

The register build also reads `data/source-additions.json`, as `data/PROVENANCE.md` records.

## Shared implementations

`lib/adapter.ts` owns `HOUSE_NUMBER_PREFIX` and `splitStreetLine(line)`, the house-number and street
split every US CSV adapter uses. Call it rather than splitting the line again in a new adapter.

## Country-implicit sources

Overture address rows carry no country token, so training on them at real weight dilutes country
emission on rows that do name one (measured at −1.6 pp with 456k CA/MX rows, and −5.3 pp with 666k BR
rows added). A country-implicit source needs a fraction of its rows rendered with a trailing country
surface (`components.country` set and aligned), using surfaces of three or more characters because a
bare alpha-2 code collides with US state abbreviations. `renderCountry()` in `country-balanced.ts` is
the precedent.

## Base corpus build cost

A base corpus build,
`mailwoman corpus build --inputs packages/corpus/data/builds/<version>/inputs.json`,
takes about 11.5 hours for roughly 680 M rows. The committed `inputs.json` records each adapter and its
input path relative to `$MAILWOMAN_DATA_ROOT`. Budget a day, run the build in the background with
`NODE_OPTIONS="--max-old-space-size=20480"`, and smoke-build two small adapters first to prove a schema
change end to end. `assertHeapForAdapters` in `lib/build/heap.ts` refuses a heap under 15 GiB when
`--inputs` names `wof-admin` or `wof-postalcode`, because both hold every source record resident and
peaked together at 14,883 MiB on 2026-09-26. `wof-admin` writes zero bytes to `canonical.jsonl` for a long opening stretch and is not hung:
`rows()` first passes over every GeoJSON file in `wof/repos` (121 GB) to build an in-memory index.

A build refuses an `--out` that holds an align checkpoint, a non-empty align output or a finished
adapter `MANIFEST.json`, and names each file with its size. To continue an interrupted build, rerun
the same command with `--resume`:
`mailwoman corpus build --inputs packages/corpus/data/builds/<version>/inputs.json --out <out> --resume`.
It reuses each finished adapter run, truncates the align outputs to the checkpoint's offsets and
aligns the remaining adapters, and keeps the parquet files the parquet manifest records. `--fresh`
deletes that work and builds from the start; nothing is deleted without one of the two flags.

## License election

A grant that enumerates its rights grants those rights and no others. An omission is neither a
permission nor a prohibition. Two of the four `INGEST_OPERATIONS`, `transform` and `train`, need
adaptation, so before electing a license grep the terms document for the verb the operation needs
(`adapt`, `modify`, `derivative`, `alter`, `translate`) rather than for the word `licence`. CC BY and
Licence Ouverte name adaptation explicitly. A bespoke government terms page may omit it, and the
omission decides the election. Record the gap in `$notElected`, which is a different record from an
absent statement and from a reservation of rights.

When a state's register is elected, read the publisher's own per-area download list (BAN's department
directory, Geonorge's area codelist, Finland's `municipality_number` column) before closing the row,
because a dependency with its own ISO 3166-1 code may already be covered under the license held. A
geocoder's merged index cannot settle it. `scopedLicenseID` scopes a decision to one publisher in one
jurisdiction, so one grant over several jurisdictions uses `sharedReadings` plus
`{"sameAs": "<body>"}` per id. A `personalDataReview` has no `sameAs`, so `source-resolutions.json`
repeats the body and documents the repetition in a `$`-prefixed key.

An empty owner column on a research-CSV row silently widens a license election to every publisher the
row lists, because `scopedLicenseID` falls back to the source id. Split the row per publisher first.
A national aggregator's license label for another publisher's feed is a third party's claim. Read the
publisher's own metadata (Bizkaia states no CC license, and Gipuzkoa states CC BY-SA 4.0 where the
national feed states CC BY).

Before recording a publisher as unreachable, probe `https://<host>/` and `https://www.<host>/`
separately and record which answered. When a site answers, also try `/terms-of-use/`,
`/privacy-policy/`, `/copyright/` and `/downloads/`; identical body lengths across them mean a
catch-all 404. A keyword match for a license on a rendered page can hit the page's own dependencies,
such as Bootstrap's MIT notice, and a publisher's terms may sit in a linked PDF rather than on the
page.

When a publisher's own download page states no license, query the national open-data portal's CKAN
API and match on `organization` rather than `title`; a third party's copy may carry the matching title
with `license_id: notspecified` while the publisher's entry carries the grant under another name.
Compare the entry's `resources` against the file to be fetched to prove the two records describe one
artifact. A portal also returns third parties' datasets about a country, and a third party's license
is not the publisher's. Record an unstated license version as unstated: leave `spdx` out and let
`electedTerms` carry the publisher's words, because `electedLicenseLabel` feeds the share-alike
filter.

Whether address data can be elected without a publisher's grant depends on the country's law, so each
country states its position in `lib/<cc>/AGENTS.md`. The United States elects a public body's file
published without terms restricting its use, because US copyright excludes facts and US law has no
database right (`lib/us/AGENTS.md`). EU and EEA members and the United Kingdom give a database's maker
rights over its contents, so their rows need the publisher's grant. Under every position, terms that
spell out a restricted use are a refusal. A country without a `lib/<cc>/AGENTS.md` has adopted no
reading, and its rows need the publisher's grant. Write that file before electing a row under any basis
other than the publisher's grant.

For an INSPIRE download service, `<Fees>` and `<AccessConstraints>` in the WFS capabilities describe
calling the service rather than the data. Member states fill them with their own word for absent
(`puudub`, `NONE`). The grant over the data is in the ISO 19139 dataset record reached from
`inspire_dls:ExtendedCapabilities` through `SpatialDataSetIdentifier` to `metadataURL`; read
`otherConstraints`, `useLimitation`, `accessConstraints` and `useConstraints` there, and tie the
record to the service by `fileIdentifier` and theme before electing. A named instrument whose text
cannot be retrieved stays `unchecked` and is never a refusal. In an ISO 19139 record the first
`<gmd:title>` is commonly a thesaurus citation (`GEMET - INSPIRE themes`); the resource title sits
under `identificationInfo` before the first `descriptiveKeywords`.
