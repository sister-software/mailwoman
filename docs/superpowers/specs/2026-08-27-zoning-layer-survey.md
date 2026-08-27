# Zoning and land use as a spatial layer — a per-jurisdiction acquisition survey

Design record for #1986. A survey, not a builder. The issue asked for the map of a patchwork rather than
a forced pilot, and named a valid negative outcome. **This record delivers a split verdict**, in the
shape the erosion survey established:

- **A recorded coverage-threshold finding for the United States.** There is no national US zoning
  dataset, there is no federal one, the catalogues that look like they could count the patchwork cannot,
  and the assemblies that have counted it publish terms a shipped layer cannot take. The threshold this
  record fixes, and the reason it is a threshold rather than a percentage, is in §7.2.
- **A pilot jurisdiction that is not in the United States.** The Republic of Ireland publishes a
  **national** zoning polygon layer covering 30 of its 31 local authorities, carrying the local
  authority's own zone code _and_ a national generic classification _in the same row_. It was measured
  end to end from this lab: 85,330 features, one anonymous download of 247,452,342 bytes. Its licence is
  declared CC-BY 4.0 on the national portal and contradicted twice elsewhere, so the pilot ships at
  `tier: build-local` rather than `shipped`. It is in §2.7 and §7.1.
- **And a third answer the issue did not ask for but the sources forced.** The obstacle to a US zoning
  layer is not that the patchwork is unmapped. Two thirds of the US population already lives in a
  jurisdiction somebody has read and normalized. **The obstacle is that publishers do not say whether
  their data may be copied** — measured at **85.0 % of 2,000 enumerated public zoning services carrying
  an empty licence field** (§2.6), with the false-negative direction tested.

The consuming machinery already exists, so nothing below proposes new architecture. The layer contract
(`layer_manifest` / `layer_coverage` on the H3 spine) is specified in
[`../../engineering/reference/layer-contract.mdx`](../../engineering/reference/layer-contract.mdx); the
exclusion-grade coverage pilot
([`2026-08-27-exclusion-grade-coverage-pilot.md`](./2026-08-27-exclusion-grade-coverage-pilot.md)) is the
basis discipline; the flood survey
([`2026-08-27-flood-layer-survey.md`](./2026-08-27-flood-layer-survey.md)) is this record's structural
template; the erosion survey
([`2026-08-27-erosion-layer-survey.md`](./2026-08-27-erosion-layer-survey.md)) is where the
meaning-of-zero inversion this subject shares was first written down; and
`packages/mailwoman/observations/absence-route.ts` with its `QueryIntentMarker` carrier delivers an
additive, provenance-carrying advisory without touching ranking.

**Every external claim below carries its URL and the date it was read.** Measurements taken from this lab
are labelled as measurements and give the command's answer rather than a summary of it. Where a fact
could not be established from a primary source it is in §10 as unverified, with what was tried. Nothing
in §10 was filled in with a plausible reading.

## 1. What this record settles, and what it deliberately does not

Settled here: the division between the three subjects the word "zoning" is used for (§2.1); the verified
inventory including the checked federal and national absences (§2); **the vocabulary decision and the
measurement that forced it (§4), which is this survey's distinctive deliverable**; **the
mixed-provenance rule as a schema constraint rather than a convention (§5)**; the storage shape and the
resolution measurement, including the one place the inherited size contract does not reach (§6); the
pilot and the recorded threshold finding (§7); and the product requirement (§8).

Not settled here, and named so nobody reads silence as a decision:

- **Whether Ireland's zoned footprint can be stated at all.** The authority says coverage is incomplete
  and publishes the detail only in a map viewer (§3.2). Until a footprint source is settled the layer
  writes `CoverageBasis.SourcePresent` and supports presence only.
- **The Tailte Éireann clause against the CC-BY declaration** (§2.7). Reported as a contradiction;
  resolving it is counsel work, not engineering work.
- **The H3 resolution** the containment index is built at (§6.4 — a measurement the pilot takes at
  candidates this record names and measures once, not a choice this record makes).
- **The spine-key declaration for a polygon-derived cell layer** — the same open question all three
  sibling surveys left, and the same answer serves all four.
- **Whether the observation's advisory code extends the existing query-intent vocabulary or widens the
  carrier** (§8), likewise shared with all three siblings.

Out of scope by the issue and kept out: the builder; any promise of national US coverage; and **any
authored zoning judgment of our own**. The layer records what an authority states, in the authority's
vocabulary, with the authority's dates. It classifies nothing.

## 2. Source inventory

### 2.1 The division this survey has to make before anything else

Three different things are published under names a reader will take as interchangeable. They have
different authors, different legal force, different update cadences and different truth conditions, and
a layer that pooled them would be this record's invention rather than any authority's claim.

| subject                            | what it is                                                                                                  | who authors it                                                       | what it answers                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------- |
| **Zoning**                         | A regulatory district adopted in law by a local legislature, stating what may be built and done on the land | A municipal or county legislative body                               | _What does the law permit here?_  |
| **Planned future land use**        | A comprehensive-plan or development-plan designation — policy intent, not a permission                      | A planning authority, adopted as a plan                              | _What does the plan intend here?_ |
| **Land cover / observed land use** | What is measurably on the ground, from imagery or survey                                                    | A mapping agency, a satellite programme, a community mapping project | _What is here now?_               |

The three disagree routinely, and one US state writes the disagreement into its own regulation. Florida
Administrative Code Rule 12D-8.008(2)(a), which governs how a county property appraiser codes a parcel,
says so directly (read 2026-08-27 at
[law.cornell.edu/regulations/florida/Fla-Admin-Code-Ann-R-12D-8-008](https://www.law.cornell.edu/regulations/florida/Fla-Admin-Code-Ann-R-12D-8-008),
HTTP 200, 54,821 bytes):

> "The appraiser shall classify each parcel of real property to indicate the use of the land as arrived
> at by the appraiser for valuation purposes… **This use will not always be the use for which the
> property is zoned or the use for which the improvements were designed** whenever there is, in the
> appraiser's judgment, a higher and better use for the land."

That is a state regulator anticipating and licensing divergence between an assessment classification and
the zoning district over the identical parcel. Every section below states which of the three subjects it
is about. §5 makes the division a schema constraint rather than a convention.

### 2.2 United States — the federal absence, checked six ways

All checks read **2026-08-27**. The issue asked whether a national US zoning dataset exists. **It does
not, and no federal agency is assigned to produce one.** That is a checked absence, and here is what was
enumerated rather than searched.

| path                            | what was checked                                                                                                                            | result                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OMB Circular A-16**           | The policy assigning each national geospatial theme to a lead agency — 891 lines, **30 themes enumerated**                                  | **`zoning` appears zero times. There is no Zoning theme and no Land Use theme.** No agency is assigned to produce one.                                                             |
| **Census TIGER**                | `www2.census.gov/geo/tiger/TIGER2025/` — **45 layer directories** listed                                                                    | zero matches for `zoning`. Control: `/PLACE/` → HTTP 200, `/ZONING/` → **404**                                                                                                     |
| **HUD**                         | The full DCAT catalogue (`hudgis-hud.opendata.arcgis.com/api/feed/dcat-us/1.1.json`, 691,873 bytes), **112 datasets**                       | **zero** with `zoning` in the title. A second path (`/api/search/v1/…?q=zoning`) returns `numberMatched: 5`, all tax or grant designation areas (Promise Zones, Opportunity Zones) |
| **EPA Smart Location Database** | Technical Documentation v3.0, **2,874 extracted lines**                                                                                     | **`zoning` appears zero times**                                                                                                                                                    |
| **data.gov**                    | `catalog.data.gov/search?q=zoning&org_type=Federal Government` → 276; `q=zoning districts` + federal → **0**; `q="national zoning"` → **0** | Of the 276, **243 are NOAA _marine_ zoning or tidal zoning**; five have `zoning` in the title, all NREL wind and solar siting                                                      |
| **FEMA regulation**             | 44 CFR § 59.1                                                                                                                               | refers to "**a community's** zoning maps" — the possessive is the finding                                                                                                          |

**EPA states the absence in its own words**, in the Smart Location Database technical documentation, and
it is the single most useful sentence in this section:

> "Since **there is no uniformly measured, publicly available national land use parcel database** that can
> be allocated to the CBG, assumptions were made about the mixture of land uses based on counts of job by
> employment sector and housing unit counts."

**HUD explains why**, verbatim from PD&R:

> "Land use regulations are implemented locally, under authority given to municipalities by their state
> government. It is generally accepted that the federal government has limited ability to influence local
> land use regulations."

**The closest federal artifact is not zoning.** NREL's _U.S. Wind/Solar Siting Regulation and Zoning
Ordinances_ is CC-BY 4.0 and national, but its GeoPackage holds "the jurisdiction shapes for each
ordinance" — counties and townships — rather than zoning districts, is scoped to wind and solar siting,
and carries its own warning: "This data was collected with the help of generative AI. The Large Language
Models used for this effort make mistakes."

**Four federal products are routinely mistaken for a national zoning layer** and none is one: NLCD and the
Cropland Data Layer are land **cover** (§2.9); the National Flood Hazard Layer is flood **risk** for
insurance rating; the National Wetlands Inventory is **habitat**, and explicitly disclaims "the
geographical scope of the regulatory programs of government agencies"; PAD-US is **ownership** and
protection status.

**One measurement trap found here.** From this lab, `catalog.data.gov`'s CKAN API is gone —
`/api/3/action/package_search?q=zoning&rows=0` returns **HTTP 404, 36 bytes,
`{"detail":{},"message":"Not Found"}`** — and `catalog.data.gov/dataset?q=zoning` **301-redirects to the
catalogue home page, dropping the query**. The counts in the table above came from a path that answers;
a survey that took this lab's redirect as an absence would have reported the wrong thing about a
catalogue that works.

### 2.3 United States — the assemblies that have read the patchwork, and what their terms say

All facts read **2026-08-27**. This is where the coverage question is actually answered, and where the
answer stops being usable.

**The National Zoning Atlas is the largest, and it forbids exactly what a layer does.** Published by
**Land Use Atlas, Inc.**, a Delaware 501(c)(3) headquartered in Washington DC — not Cornell, whose Legal
Constructs Lab began it. Terms of use §1.2 and §1.3, verbatim:

> "**1.2. Content.** From time to time, the content on the website may include, among other things,
> information, software, processes, maps, **geospatial data**, text, illustrations, displays, images,
> trademarks, designs, icons, photographs, video, and audio (collectively, the "Website Content"), all of
> which are owned by either LUAI or LUL and are protected by United States and international copyright,
> trademark, patent, trade secret, and other intellectual property or proprietary rights laws."

> "**1.3. Limitations.** Unless you have our express written permission, you may not use, host, store,
> reproduce, modify, license, create derivative works of, communicate, download, publish, publicly
> display, or **distribute** any of the Website Content. If we provide you with express written permission
> to take such actions with regard to the Website Content: (a) you must display and keep intact all
> copyright and other proprietary notices; (b) you must credit the "National Zoning Atlas, online at
> zoningatlas.org," (c) you must **not commercially use (including sell)** any of the Website Content;
> and (d) you must not use the materials in a manner that suggests LUAI or LUL approval or participation
> without our written permission."

Scraping is banned separately (§2.2). Screenshots with credit are the only free use. There is no bulk
download, no public data API and no tile service: `edit.zoningatlas.org/atlas/` and
`api.zoningatlas.org/` both return **HTTP 403** with `cf-mitigated: challenge`, the `sitemap.xml`'s 465
URLs contain no downloads page and no data-licence page, and the project's DOI `10.4079/zoning-atlas`
**302s to the web map rather than to a data deposit**. As of spring 2026 bulk files and API access moved
to **Land Use Labs LLC**, a commercial arm, under a separate agreement.

**Its coverage numbers are the best available, and both what they are and where they come from need
stating.** The homepage renders them from `api.zoningatlas.org/nza_coverage`, which returns **HTTP 403**
to this network plain and browser-headed, so the figures below are read from the page markup, **where they
are the fallback values the page shows when the endpoint does not answer** (§10):

| field                   |           value | the label it is published under                        |
| ----------------------- | --------------: | ------------------------------------------------------ |
| `jurisdictions_covered` |      **11,015** | "Jurisdictions Published to the National Zoning Atlas" |
| `pages_analyzed`        |       1,337,510 | "Pages of Zoning Codes Read"                           |
| `population_covered`    | **224,494,683** | "People Living in Published Jurisdictions"             |

Against "WE'VE identified **33,295** jurisdictions" on the same site. **The widely-quoted "more than
33,000 jurisdictions" is the universe they have identified, not what they have published** — published
coverage is 11,015 of 33,295, about 33 % of jurisdictions. A separate undated claim of "over 50% national
coverage" appears on the project's analysis page **with no stated denominator**, and it matches neither
the jurisdiction ratio nor the population ratio, so it is not used here.

**The state chapters publish separately, under four different regimes**, and the rights chain back to
Land Use Atlas is nowhere stated:

| chapter                           | measured                                                                  | terms                                                                                |
| --------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Montana**, **Hawaii** (GitHub)  | MT 535 districts / 62 jurisdictions; HI 262 features, 25.7 MB             | **MIT licence file at the repository root**                                          |
| **Vermont** (VCGI / UVM)          | 1,736 records, 240+ fields, queryable feature service                     | `licenseInfo` **empty**, `copyrightText` **empty**                                   |
| **New Hampshire** (Saint Anselm)  | 269 jurisdictions, 1,869 districts                                        | a liability disclaimer, **no grant**                                                 |
| **Washington** (Dept of Commerce) | **470,130 zones, 320 jurisdictions**                                      | a terms page carrying an RCW 42.56.070(8) clause forbidding commercial use of lists  |
| **Mercatus Center mirrors**       | 10 state and regional files; `mt_zoning_atlas_2023.zip` = 3,361,026 bytes | **no licence, terms, attribution or citation statement**, on the page or at `/legal` |

Washington also uses **a different vocabulary**: a `WAZAZoneGeneral` field over thirteen codes
(`COM`, `IND`, `LIR`, `MIL`, `MR`, `MXU`, `NRL`, `OS`, `PUB`, `RUR`, `TRB`, `UND`, `UNK`) rather than the
national chapter's district-type field, so the state chapters are not one dataset in several files.

**Three assemblies do carry a usable licence, and none of them carries geometry.**

- **Eviction Lab's National Zoning and Land Use Database (NZLUD)**, Princeton — **MIT licensed**, stated
  in both `LICENSE` and `README.txt`. Measured: `nzlud_muni.csv` = 827,091 bytes, **2,639 rows × 77
  columns**, keyed on `GEOID`. **No geometry column of any kind.** Its authors state that it replicates
  the 2006 WRLURI sampling frame, so "many MSAs in our sample are missing data for a large proportion of
  their municipalities", and they ship `msa_coverage_rates.csv` quantifying it (Abilene TX 1 of 17;
  Akron OH 11 of 58).
- **Urban Institute's National Longitudinal Land Use Survey (NLLUS)** — **ODC-BY 1.0**, per its own
  citation. Jurisdiction survey responses for the top 50 CBSAs; 2019 wave emailed to 2,945 jurisdictions,
  1,703 responded. **No geometry.** (`urban.org` returns HTTP 403 to this network; this rests on a single
  archived read — §10.)
- **Berkeley's Othering & Belonging Institute**, seven repositories including `CAZoning` — statewide
  California as per-municipality GeoJSON across 55 county directories, with real polygons (Alhambra alone
  is 12,993,436 bytes and **19,410 polygons**). **Its `LICENSE.txt` is MIT, and its README says the data
  is for "broad, noncommercial public use".** Those two statements cannot both govern. Two sampled files
  also carry **different schemas and different coordinate reference systems** (`city_zone`/`zone_descp`
  in CRS84 against `general_pl`/`Zoning` in EPSG:3493).

**WRLURI is freely downloadable and carries no licence at all.** The 2018 wave (Stata `.dta`, 6,731,396
bytes, 150 variables × 2,844 observations) and the 2006 wave (1,444,496 bytes) are the only two waves that
exist. The unit is one responding municipality, from a survey ICMA sent to 10,949 members with 2,825
responses — a 25.8 % response rate. All 150 variable names were scanned for
`lat|lon|geom|shape|wkt|poly|coord|centroid|boundar`: **zero hits**. Four candidate terms-of-use URLs
returned 404 and the page's only legal text is a copyright notice. **Absence of a stated restriction is
not a grant**, and this record does not treat it as one.

**One statewide government product outweighs all of the above for usability.** California's Office of
Land Use and Climate Innovation publishes _Statewide Zoning North_ and _Statewide Zoning South_ on
`data.ca.gov`. **The two feature counts were re-measured for this record and are 264,417 and 304,324 —
568,741 zoning polygons**, published in CSV, shapefile, GeoJSON, GeoPackage and file geodatabase, with a
14-value normalized `ucd_description` vocabulary beside the local `Code` and `Descriptio` fields. The
publisher claims 535 of California's 539 jurisdictions; a distinct-value count over both halves resolves
to **534** after de-duplication. Its CKAN `license_id` is **null**, its ArcGIS `licenseInfo` is **empty**,
and its rights field reads "No restrictions on public use". That is a stated non-restriction rather than
a grant, and §7.2 treats it as such. Its own dataset description is candid about method: where "zoning
maps were not available in a GIS format, maps were converted from PDF or image maps using geo-referencing
techniques and then transposing map information to parcel geometries sourced from county assessor data",
with collection "begun in late 2021 and… mostly finished in late 2022". The `Date` column is free text —
grouping by it returns 61 distinct values, nothing later than 2023, plus an unconverted spreadsheet serial
and 4,605 features dated `7/11/1905`.

**Every commercial assembly forbids redistribution, and they are one supply chain rather than four.**
Regrid's zoning is Zoneomics's, stated in Regrid's own documentation — "Our zoning data partner Zoneomics
created and utilizes a proprietary system to extract, process, analyze, and standardize zoning data" —
and Redfin's consumer zoning is Zoneomics too. Regrid publishes 27 standardized zoning fields and a
measured coverage sheet showing **160,832,639 parcels across 3,231 counties, `zoning_pct` 88 nationwide**;
its Data Store License Agreement forbids reselling, sublicensing or "otherwise making the Data available
to third parties", expires after one year, and separately prohibits uploading the data to any public
language model. Zoneomics, LightBox, ATTOM and Placekey each carry an equivalent clause. Zillow and Redfin
publish **no** zoning data at all — the word appears zero times on both research-data pages.

### 2.4 United States — the states that do aggregate, and what each one's layer actually is

All measurements taken **2026-08-27** against the live services. **More states aggregate than the issue
expected, and the reason none of them adds up to a national layer is not coverage — it is that each
answers a different question, at a different vintage, under different terms.**

| state              | verdict                                         | measured                                                                                                               | the catch                                                                                                          |
| ------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **California**     | **statewide zoning**                            | **568,741** polygons; **534** distinct jurisdictions measured against a claimed 535 of 539                             | `license_id` **null**; source dates 2021–2023 and a dirty `Date` column                                            |
| **Washington**     | **statewide zoning**                            | **470,130** zones, **6,034** overlays, **320** jurisdictions = 39 counties + 281 cities                                | a commercial-use restriction under RCW 42.56.070(8)                                                                |
| **Oregon**         | **statewide zoning**                            | **114,823** polygons; **245** jurisdictions (209 cities + 36 of 36 counties)                                           | vintage 2023-06-30; the description claims 229 jurisdictions against 245 measured                                  |
| **Hawaii**         | **statewide zoning, two tiers**                 | State Land Use Districts **906** polygons + county zoning **14,913** across 4 of 4 counties                            | two products, two vocabularies                                                                                     |
| **Rhode Island**   | **statewide zoning**                            | **15,733** zones + 1,639 overlays; **39 of 39** municipalities                                                         | the most complete small state found                                                                                |
| **Vermont**        | **statewide zoning**                            | **1,746** polygons; **208 of 256** town units                                                                          | `licenseInfo` **empty**                                                                                            |
| **New Hampshire**  | statewide zoning, academic publisher            | **3,302** districts                                                                                                    | a liability disclaimer, no grant                                                                                   |
| **Connecticut**    | statewide zoning, **non-government and frozen** | **2,297** districts; **169 of 169** towns; 14,808,908 bytes                                                            | `Last-Modified: 2022-04-27`, unchanged for four years, **and its source repository returns 404**                   |
| **Utah**           | statewide zoning, self-labelled in progress     | **749** polygons; **69 of 261** municipalities (**26 %**)                                                              | the publisher labels it `IN PROGRESS`                                                                              |
| **Wisconsin**      | **county-administered only, frozen**            | **402,407** polygons; **51 of 72** counties; **zero cities or villages**                                               | `DBF_DATE_LAST_UPDATE = 2017-07-31`; Milwaukee, Madison and Green Bay are absent                                   |
| **Maryland**       | **generalized only**                            | **2,289** polygons; 24 of 24 jurisdictions                                                                             | **no local zone code at all**, and **64.1 % of rows still carry a 2020 update year**                               |
| **Florida**        | **future land use only**                        | 479 source jurisdictions, 67 of 67 counties                                                                            | a comprehensive-plan designation, not zoning (§2.1)                                                                |
| **Massachusetts**  | **retired**                                     | the catalogue's 238 layer pages contain `zoning` **zero times**; the download bucket's 287 keys hold no zoning archive | what remains is the MBTA Communities 3A District Atlas — real adopted zoning, **153 of 351 municipalities (44 %)** |
| **New Jersey**     | **none — and this is the trap**                 | **564 features against 564 municipalities**                                                                            | see below                                                                                                          |
| **Minnesota**      | county-by-county only                           | **2 of 87** counties (2.3 %)                                                                                           | —                                                                                                                  |
| **North Carolina** | county-by-county only                           | 0 of 100 counties                                                                                                      | —                                                                                                                  |
| **Montana**        | none from the state                             | zoning is not an MSDI framework theme; `zoning` appears **zero times** on the MSDI page                                | the 39 "zoning" matches in the state's 1,090 ArcGIS items are **every one a Channel Migration Zone**               |
| **Delaware**       | none                                            | **1 of 57** municipalities (Lewes), 0 of 3 counties                                                                    | —                                                                                                                  |

**Maryland states its own limitation, and it is the vocabulary decision arriving from the other
direction**, verbatim: "Generalized zoning data is **not meant to substitute for local zoning
information** and should not be used to determine permissible uses." A statewide layer that ships eleven
generalized classes and drops the local code has discarded the column §4.2 makes mandatory.

**New Jersey is the most dangerous dataset in this survey, and it is dangerous because it scores
perfectly.** The Department of Community Affairs publishes a statewide layer named **"Municipal
Zoning"**, with **564 features against New Jersey's 564 municipalities** — a coverage script measuring
jurisdictions-with-a-row reports 100 % and is entirely wrong. Its fields are `Muni`, `Municipali`,
`County_1`, **`Map`**, **`Ordinance`**, **`Website`**. There is no zoning code and no district geometry:
the attributes are hyperlinks to each town's PDF zoning map. The Department says so itself, verbatim:

> "This layer contains **links to online municipal zoning maps, zoning ordinances and zoning office
> contact information** known to the Department of Community Affairs as of March 23, 2026… **The
> Department of Community Affairs cannot confirm the currentness or accuracy of these documents** and
> provides these links as an information resource for the public."

**And California publishes a near-identical companion that is the other subject.** `California General
Plan Land Use` holds **534,346** features across 532 of 539 jurisdictions in a schema close enough to the
zoning layer's to be mistaken for it. It is future land use (§2.1). **The only thing separating them is
the service name.**

**Three further near-misses, all of which share vocabulary with zoning and none of which is zoning.**
NJDEP's Land Use/Land Cover 2020 is **699,777** imagery-derived Anderson-code polygons carrying labels
like `RESIDENTIAL, HIGH DENSITY OR MULTIPLE DWELLING`. Montana's MSDI framework theme is literally named
"Land Use/Land Cover" and sits exactly where a zoning theme would sit in its fifteen-theme list; it is a
30 m raster. Maryland's Land Use 2018 is derived from tax-assessment records plus land cover validated
against aerial imagery. **The distinguishing test is provenance, never the class name.**

### 2.5 United States — a spread of county and municipal portals

Twenty-one jurisdictions sampled across nine states and every size band, deliberately including small and
rural counties. All measured **2026-08-27**.

| jurisdiction            | machine-readable                        | features [measured] | code field      | description field    | terms                                               |
| ----------------------- | --------------------------------------- | ------------------: | --------------- | -------------------- | --------------------------------------------------- |
| Los Angeles County CA   | yes                                     |              14,612 | `ZONE`          | `Z_DESC`             | an explicit commercial licence                      |
| City of Los Angeles CA  | yes                                     |              58,856 | `Zoning`        | `CATEGORY` coarse    | disclaimer only                                     |
| City of Chicago IL      | yes                                     |              14,929 | `ZONE_CLASS`    | **none**             | a mandatory attribution string                      |
| Cook County IL          | yes, unincorporated only                |               2,796 | `ZoneID`        | `ZoneDesc`           | **"for personal use"**                              |
| **Harris County TX**    | **no — no zoning authority**            |                   — | —               | —                    | —                                                   |
| **City of Houston TX**  | **no — no zoning ordinance**            |                   — | —               | —                    | contradictory metadata                              |
| Maricopa County AZ      | yes, unincorporated only                |              10,160 | `ZONE`          | **none**             | **commercial use prohibited**                       |
| City of Phoenix AZ      | yes                                     |               9,651 | `ZONING`        | `GEN_ZONE` coarse    | redistribution granted                              |
| King County WA          | yes, unincorporated only                |               5,312 | `CURRZONE`      | **none**             | **no redistribution without written authorisation** |
| City of Seattle WA      | yes                                     |               3,627 | `ZONING`        | `ZONING_DESC`        | **PDDL — the only open licence found**              |
| Mecklenburg County NC   | yes                                     |                 977 | `zone_des`      | none                 | disclaimer only                                     |
| City of Charlotte NC    | yes                                     |               5,689 | `ZoneDes`       | `ZoneClass`          | disclaimer only                                     |
| Jefferson County AL     | service exists, **403 to this network** |          unverified | unverified      | unverified           | metadata says "no use limitations"                  |
| Sedgwick County KS      | yes, covers Wichita                     |              19,123 | `ZONING`        | a coded-value domain | disclaimer, not on the layer                        |
| City of Fargo ND        | yes, parcel-attributed                  |              38,876 | `Zone1`/`Zone2` | **none**             | disclaimer only                                     |
| **Cass County ND**      | **no**                                  |                   — | —               | —                    | a public-domain grant, and no data                  |
| Bannock County ID       | yes — **13 polygons**                   |                  13 | `Zone`          | none                 | unverified                                          |
| City of Pocatello ID    | yes                                     |                 269 | `Zone_Code`     | `ZONE`               | **redistribution expressly forbidden**              |
| Sumter County FL        | yes, at an **undocumented** URL         |              70,953 | `Zone_Type`     | **none**             | no resale without the county board's consent        |
| **Lea County NM**       | **no — PDF and paper only**             |                   — | —               | —                    | unverified                                          |
| Screven County GA       | yes, via a regional commission          |                  90 | `ZONING_CODE`   | **none**             | disclaimer only                                     |
| **Goshen County WY**    | **no — no ordinance**                   |                   — | —               | —                    | —                                                   |
| **Gillespie County TX** | **no — no ordinance**                   |                   — | —               | —                    | —                                                   |
| **Dawes County NE**     | **no — the service is stopped**         |                   — | —               | —                    | unverified                                          |

**Houston does not have zoning, and its own letter is more precise than the slogan.** The City's
Planning and Development Department states, verbatim: "**The City of Houston does not have zoning**, but
development is governed by ordinance codes that address how property can be subdivided. **The City codes
do not address land use.**" The stronger instrument is the City's own signed _Official City of Houston
Zoning Letter_ (HTTP 200, 7,561,533 bytes), verbatim:

> "**The City of Houston does not have a city-wide comprehensive zoning ordinance.** However, there are
> certain land use regulations for properties located within the areas described below… Tax Increment
> Reinvestment Zone (TIRZ) No.1, St. George Place - Zoning regulations control the use of land within the
> TIRZ boundaries."

So "Houston has no zoning" is true only at city-wide scale: airport land-use envelopes and one tax
increment zone carry real land-use control. And Houston's own Land Use layer — **1,538,086 features** —
is not a substitute, by its own description: "Land Use derived by City of Houston staff based on
**appraisal district land use codes**." That is §2.1's assessment category, and the Florida rule quoted
there says why it will not match the zoning.

**Texas counties have no general zoning power, verified from the statute.** Tex. Loc. Gov't Code Ch. 211
grants zoning to "the governing body of a **municipality**". Ch. 231, titled _County Zoning Authority_,
has one definitional section conferring no power, and **every operative subchapter is geographically
restricted** — Padre Island, Amistad, military zones, named lakes, the El Paso Mission Trail, Hood County.
Harris County's own Fair Housing plan states it plainly: "**In the State of Texas counties are not granted
zoning powers** and have limited power to guide development and as a result, private deed restrictions and
covenants usually govern land use and development." Gillespie County confirms the pattern independently:
its adopted subdivision regulations extract to 311,117 characters with **zero occurrences of "zoning"**.

**Five findings from the sample that a builder needs, and each is measured.**

1. **Almost nobody grants reuse.** Across 21 jurisdictions, **exactly one open licence identifier
   appears** — Seattle's PDDL. Three affirmatively forbid redistribution or commercial use. The rest are
   liability disclaimers that say nothing about copying, which leaves reuse governed by default copyright.
2. **City and county terms contradict each other inside one metropolitan area.** Phoenix grants
   redistribution while Maricopa County forbids commercial use; Seattle dedicates to the public domain
   while King County requires written authorisation. There is no metro-level answer.
3. **County layers are unincorporated-only and never nested.** Proven for Maricopa by a
   `returnDistinctValues` on `JURIS`, which returns exactly `['COUNTY']`. Countywide coverage means
   unioning every municipality separately.
4. **There is no field-naming convention**, and a description field is the exception rather than the rule.
   The zoning code appears as `ZONE`, `ZONING`, `ZONE_CLASS`, `ZoneID`, `CURRZONE`, `ZoneDes`, `zone_des`,
   `Zone1`, `Zone_Code`, `Code`, `ZONING_CODE`, `Zone_Type`, `orZCode`, `GENZONE`, `ludcode` and
   `source_zone`. **Chicago, Maricopa, King County, Fargo, Bannock, Screven and Sumter ship codes with
   nothing to expand them** — §4.2's verbatim-code rule is the only thing that can be honoured there.
5. **Prose vintage disagrees with data vintage, and the prose is the stale half.** Los Angeles County's
   description says "last updated through 12/16/14" while its own `Date_Updated` column measures
   2024-11-08 to 2026-08-12. Oregon's description claims 229 jurisdictions against 245 measured.

**And HTTP 200 repeatedly meant failure.** Screven County's published layers return 200 carrying
`{"error":{"code":500}}`; Dawes County's advertised service returns 200 carrying "Service may be stopped";
the Census API returns **200 `text/html`** titled "Missing Key"; Minnesota's CKAN API returns 200 with a
94,488-byte application shell; and Mecklenburg County's own published item URL is **misspelled**
(`Unicorporated…`), returning a 404 error body inside an HTTP 200. **A harvester checking status codes
alone records healthy endpoints and ingests nothing.** Layer index `0` is not safe either — Los Angeles
City's zoning is at `/15`, Vermont's at `/8`, Rhode Island's at `/1` with overlays at `/0`, Hawaii's five
at 20, 2, 29, 33 and 3 — and a wrong index returns `{"error":{"code":400,"message":"Invalid URL"}}`, which
reads as a broken service.

### 2.6 The catalogues cannot count the patchwork — measured, twice

The obvious way to size US coverage is to ask a catalogue how many zoning layers are published. **Both
catalogues that could answer return a number that is not a count**, and the failure is the kind this
repository keeps writing down: a precise-looking figure that a reader would take at face value.

**ArcGIS Online's search API returns a ceiling, not a total.** Measured 2026-08-27 against
`https://www.arcgis.com/sharing/rest/search?q=<query>&f=json&num=1`:

| query                               | `total` |
| ----------------------------------- | ------: |
| `zoning`                            |  10,000 |
| `zoning districts`                  |  10,000 |
| `zoning AND type:"Feature Service"` |  10,000 |
| `title:zoning`                      |  10,000 |
| `tags:zoning`                       |  10,000 |
| `zzzqqxnonsensetermxyz`             |       0 |

The nonsense query answers 0, so the API works. Every real query answers exactly 10,000, which is the
service's cap. **A survey that reported "10,000 zoning layers" would be reporting the ceiling.**

**ArcGIS Hub's dataset API answers, and its answer is internally inconsistent.** Measured against
`https://hub.arcgis.com/api/v3/datasets`, reading `meta.stats.totalCount`:

| query                     |   total |
| ------------------------- | ------: |
| `q=zzzqqxnonsensetermxyz` |       0 |
| `q=zoning`                | 500,893 |
| `q="zoning districts"`    | 944,023 |
| `filter[tags]=zoning`     |  43,960 |

**The quoted phrase matches almost twice as many records as one of its own words.** A phrase cannot be
more common than its parts, so `totalCount` is not counting what the query asked for. The tag filter is
the only figure with a defensible meaning, and it is still not a jurisdiction count.

**A sample says how far off it is.** The first 50 records under `filter[tags]=zoning` (2026-08-27) were
read by hand. **Four are a current adopted zoning-district polygon layer for a US jurisdiction** —
Yavapai County AZ (798 records), Hawaii County and Kauai County (7,721 and 1,953, both published by the
Hawaiʻi Statewide GIS Program), and Los Angeles County's `Existing Zoning (outline)` (2,281). The other
46 are: 20 Los Angeles County _proposed-change_ artifacts (`Proposed Zoning Change`, `Proposed LUP
(shading)`, `Proposed Zoning Outline`), 8 Canadian records (Thompson-Nicola Regional District BC, United
Counties of Leeds and Grenville ON, City of Courtenay BC), overlays and buffers (`Oak Woodland OAK`,
`Loudoun Steep Slopes`, `500m Waste Influence Area`, `Residential Base Zone by Area … 600 Ft Buffer`),
future-land-use layers (`Character Area Future Land Use`), and three records of **Ireland's** national
zoning layer, which is how §2.7 was found.

So the sampled precision is **4 in 50, 8 %**. Applied to 43,960 that suggests on the order of 3,500
records, before de-duplication — and de-duplication is most of the work, because Los Angeles County alone
contributed 20 of the 50.

**The publisher facet shows why de-duplication cannot be automated.** Aggregating
`filter[tags]=zoning` by `source` with `agg[size]=1000` returned 1,000 buckets covering 27,019 of 43,960
records (61.5 %), with the thousandth bucket still holding 8 records — so the tail runs well past 1,000
distinct publishers. The top bucket is **"University of Florida" with 947 records**. The list mixes
counties and cities with universities, consulting firms (`GEO Jobe GIS Consulting`, `QCGIS Consulting,
LLC`, `WSB`), personal accounts (`AndersonSusan`, `Loftus59`, `salehmuth1`), regional planning
commissions, and non-US publishers (`Wicklow County Council`, `The City of Saint John`). The field is
also dirty in a way that defeats grouping: `      City of Bowling Green, KY` and `     Huntingdon County`
carry leading whitespace.

**A narrower enumeration does produce a usable number, and its most important column is empty.** Restricting
to public feature services titled _Zoning Districts_ and enumerating the population rather than reading a
`total`: **2,041 services, of which 2,000 were enumerated, across 1,279 distinct owner accounts — and 911
owners (71.2 %) publish exactly one.** Sampling 60 at random, **only 36 (60 %) returned a feature count
anonymously**; the median reachable layer holds 150 features. And the licence field:

> **1,700 of the 2,000 (85.0 %) carry an empty `licenseInfo`.**

**That 85 % is a real absence rather than a measurement artifact, and the failure direction was tested
specifically**: re-checking 25 search-reported-empty items against the item endpoint confirmed **25 of 25
empty, zero false negatives**. So the largest single obstacle to a US zoning layer is measurable, and it
is not discovery and not format — **it is that five publishers in six say nothing at all about reuse**,
which leaves reuse governed by default copyright.

**The conclusion this forces is §7.2's.** A jurisdiction-coverage map of the United States cannot be
produced by querying a catalogue. It can only be produced the way the assemblies in §2.3 produced
theirs — a person opening a jurisdiction's records and reading them — which is exactly why those
assemblies exist and exactly why their terms matter so much.

### 2.7 Ireland — a national zoning layer that ships the crosswalk beside the verbatim code

All facts and measurements in this section read or taken **2026-08-27**. This is the pilot, and it was
found by sampling a catalogue that could not count (§2.6) rather than by looking for it.

**The product.** _Generalised Zoning Types (GZT)_, published by the **Department of Housing, Local
Government and Heritage** for the MyPlan.ie project. Two feature layers on the Department's own ArcGIS
Online organisation (`orgId` `NzlPQPKn5QF9v2US`, owner `GZT_curator`):

- `GZT Current Plan` — item `5c2608ebedd84013aaeff8bf669e8596`, service
  [`.../GZT_Current_Plan/FeatureServer/0`](https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/GZT_Current_Plan/FeatureServer/0),
  **85,330 features** (`returnCountOnly` and the bulk export agree exactly).
- `GZT Expired Plan` — item `bfc2633e0b23411d8f61ad90f1cdb8ef`, **7,331 features**.

Item created 2024-07-05, modified 2026-05-13; latest `UPLOAD_DATE` in the data is **2026-06-18**. The
service reports `capabilities: Query,Extract`, `maxRecordCount: 2000`, `spatialReference` **EPSG:2157**
(Irish Transverse Mercator), and a declared extent of (−10.5455, 51.4528) to (−5.9478, 54.4739) — the
Republic of Ireland, excluding Northern Ireland.

**What the Department says it is**, verbatim from the item description:

> "Generalised Zoning Types developed for the Myplan.ie project. This represents a consistent zoning
> scheme across all local authorities, and **complements (rather than replaces) the existing statutory
> zoning used for each individual plan**. Awaiting data for some Local Authorities - please see map
> viewer for coverage details."

That sentence is this survey's central exhibit. A national authority built a shared vocabulary over 30
local vocabularies, published both, and stated in writing that the shared one does not replace the local
one. §4 adopts that posture as the layer's rule.

**The schema carries both, in the same row.** Field list, verbatim from the layer's `?f=json`:

| field                                     | what it is                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `ZONE_ORIG`                               | **the local authority's own zone code, verbatim** — `RES`, `EE`, `HA-DM`, `RA - Rural Area` |
| `ZONE_DESC`                               | the local authority's own description of that zone                                          |
| `ZONE_LINK`                               | a link to the local authority's development plan                                            |
| `ZONE_GZT`                                | **the national generic zoning type** — a coded-value domain named `GZT Code`                |
| `GZT_DESC`, `GZT_LINK`                    | the generic type's description and its reference document                                   |
| `SZO`                                     | `Standardised Zoning Objective` — a second, coarser national code                           |
| `LA_CODE`, `LA_NAME`                      | the jurisdiction the row belongs to                                                         |
| `PLAN_ID`, `PLAN_NAME`, `PLAN_LEVEL`      | the plan the zone comes from; `PLAN_LEVEL` domain `DP` / `LAP` / `SDZ`                      |
| `PLAN_FROM`, `PLAN_TO`                    | the plan's own validity window                                                              |
| `CURRENT_PLAN`                            | domain: `1` Current plan, `2` Expired and not replaced, `0` Expired and replaced            |
| `COLOUR`, `UPLOAD_DATE`, `ZONE_DESC_TEMP` | rendering, ingest date, and an unexplained duplicate description column                     |

**Coverage — measured, and one authority is missing.** A `groupByFieldsForStatistics` over
`LA_CODE,LA_NAME` returns **30 distinct local-authority codes and 28 distinct names** (Cork and Galway
each appear twice, as city and county). Ireland has **31 local authorities**, and the one absent from the
layer is **Donegal County Council**.

Against Census 2022, the CSO's own table `FY003A` (_Population_, by Administrative Counties;
`https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/FY003A/JSON-stat/2.0/en`,
HTTP 200, 6,355 bytes): the State is **5,149,139** and Donegal is **167,084**. So

> **4,982,055 of 5,149,139 residents — 96.76 % — live in a local authority whose zoning is represented in
> this layer.** Denominator: the Republic of Ireland's Census 2022 usually-resident population, CSO table
> `FY003A`.

**That number is a jurisdiction statement and nothing more, and §3.3 keeps it apart from the other one.**
Living in a covered authority is not the same as having a zoning polygon at your address.

**Per-authority, measured** (`ZONE_ORIG` distinct counts and feature counts):

| authority                 |        features | local codes |
| ------------------------- | --------------: | ----------: |
| Clare (`CL`)              |           6,982 |             |
| Dublin City (`DU`)        |           6,932 |             |
| Fingal (`Fl`)             |           5,688 |             |
| Galway (`GA`)             |           5,567 |             |
| Limerick (`LI`)           |           5,531 |             |
| South Dublin (`SD`)       |           5,478 |          16 |
| Louth (`LO`)              |           5,059 |             |
| …                         |                 |             |
| Roscommon (`RO`)          |             264 |             |
| smallest local vocabulary | Monaghan (`MO`) |      **10** |
| largest local vocabulary  |  Kildare (`KE`) |      **85** |

`LA_CODE` is dirty in the way §4.4 warns about: Fingal's code is **`Fl`** with a lowercase second letter,
against `CL`, `CO`, `DU` and the rest.

**Currency — `CURRENT_PLAN = 1` does not mean "in force today".** All 85,330 rows in the Current layer
carry `CURRENT_PLAN = 1`, which the domain defines as `Current plan` (as against `Expired and not
replaced` and `Expired and replaced`). But **2,363 of them (2.77 %) have a `PLAN_TO` already in the
past** as of 2026-08-27, measured with `where=PLAN_TO < DATE '2026-08-27'`. The plan-end distribution:

| plan ends |  2025 | 2026 |   2027 |   2028 |   2029 |  2030 |  2031 |
| --------- | ----: | ---: | -----: | -----: | -----: | ----: | ----: |
| features  | 1,839 |  947 | 12,652 | 39,328 | 18,348 | 9,645 | 2,571 |

`PLAN_FROM` runs from 2012-10-08; no row has a future `PLAN_FROM` and none has a NULL `PLAN_TO`. So
`CURRENT_PLAN` means "not superseded", and the plan window is a separate fact the consumer must read.
`PLAN_LEVEL` splits **68,669 Development Plan** rows from **16,661 Local Area Plan** rows; the declared
`SDZ` (Strategic Development Zone) value appears on none.

**Acquisition — three routes, measured.**

1. **Bulk GeoJSON**, via the Hub download API. `GET
https://hub.arcgis.com/api/download/v1/items/5c2608ebedd84013aaeff8bf669e8596/geojson?redirect=false&layers=0`
   returns `{"status":"Completed","resultUrl":…}`; following the result URL (it 302s, so `-L` is
   required) returned **HTTP 200, 247,452,342 bytes in 41.1 s**, a `FeatureCollection` of exactly 85,330
   features with no null geometry.
2. **The query API**, paginated at `maxRecordCount` 2000, with `outSR` — `outSR=4326` returns WGS84
   correctly.
3. **The service metadata**, which carries the coded-value domains and is the only retrievable copy of
   the generic-type vocabulary (see the dead documentation host below).

**Three acquisition traps, each measured, each capable of producing a well-formed wrong answer.**

**(a) The bulk GeoJSON is not in WGS84, and says so in a member the format removed.** Coordinates in the
downloaded file run x ≈ 701,873–730,724 and y ≈ 735,435–766,394 — Irish Transverse Mercator metres. The
file carries a top-level `"crs": {"type":"name","properties":{"name":"EPSG:2157"}}`. RFC 7946 specifies
WGS84 and **removed the `crs` member**, so a strict reader ignores it and places Ireland's zoning at
latitude 735,435. A reader that honours the legacy member (GDAL does) is fine. Use `outSR=4326` on the
query path, or reproject and assert the result lands inside the Department's declared bounding box.

**(b) Holes are encoded by ring ORIENTATION, not by nesting — and this one changes point-in-polygon
answers.** Measured on the largest feature, `OBJECTID` 17175, Meath's `RA - Rural Area`:

- The export gives it as a `MultiPolygon` of **107 parts, each with exactly one ring and zero nested
  interior rings**.
- Signed ring areas: **5 clockwise totalling −2,306.8 km², 102 counter-clockwise totalling +74.7 km²**.
- The signed sum is **−2,232.1 km²**, matching the Department's own `Shape__Area` of **2,232.1 km²** to
  the tenth of a square kilometre. The absolute sum is 2,381.4 km².

So the service uses the ESRI convention — **clockwise is exterior, counter-clockwise is a hole** — which
is the inverse of RFC 7946's, and it flattens every ring into its own MultiPolygon part. **Both output
formats do it**: `f=geojson` and `f=json` from the query API return the same 107 rings with the same 5/102
split. Across the whole export, **1,210 of 85,330 features (1.42 %) carry at least one hole this way**,
and reading every ring as an exterior over-reports the national zoned area by 222.1 km²:

| national zoned area, computed three ways | km²         |
| ---------------------------------------- | ----------- |
| sum of absolute ring areas               | **5,666.6** |
| sum of signed ring areas                 | **5,444.5** |
| the Department's own `Shape__Area` sum   | **5,444.5** |

The area error is 4.1 % and is the harmless half. The harmful half is that a ray-cast treating all 107
rings as exteriors answers **"inside `P5` rural zoning"** for locations the plan deliberately carved out.
**The check is free and it is exact:** compute the signed sum and compare it to `Shape__Area`.

**(c) The published definition of the crosswalk vocabulary is unreachable.** Every one of the 85,330 rows
carries a `GZT_LINK` under `https://viewer.myplan.ie/` — 36,438 at `gztcoderef.htm#Residential`, 26,344 at
`#Conservation`, 7,810 at `#Mixed`, and so on. **`viewer.myplan.ie` has no A or AAAA record** (`getent
hosts` returns nothing; `curl` exits 6). Three candidate replacements on the live host —
`www.myplan.ie/gztcoderef.htm`, `www.myplan.ie/zoning-map-viewer/gztcoderef.htm`, `myplan.ie/gztcoderef.htm`
— all return **HTTP 404**. The vocabulary's 54 code-to-name pairs survive in the service's own coded-value
domain, which is the second path; the **definitions** behind them were not retrieved (§10).

The same shape appears on Ireland's open-data portal. The `data.gov.ie` record
[`generalised-zoning-types`](https://data.gov.ie/dataset/generalised-zoning-types) (`metadata_modified`
2026-07-14) carries exactly two resources, both on `https://maps.environ.ie/arcgis/rest/services/MyPlan/GZTZoning/MapServer`
— and **`maps.environ.ie` has no DNS record either**. The record's `organization` is harvested as _Marine
Institute_, and its `notes` field is null. The live data is on ArcGIS Online under a different owner, and
the national portal does not point at it.

**Licence — CC-BY 4.0 is declared, and two other statements in the same publication disagree with it.**
Three published statements, all read 2026-08-27:

1. **`data.gov.ie`** — `license_id: "CC-BY-4.0"`, `license_title: "Creative Commons Attribution 4.0"`,
   `license_url: https://creativecommons.org/licenses/by/4.0/`.
2. **The ArcGIS item's `licenseInfo`**, verbatim in two parts:

   > "The Department encourages the free dissemination of data and aims to publish its data holdings into
   > the future, **where possible**, as Open Data licensed under Creative Commons Attribution 4.0
   > International Licence (CC-BY)."

   and, in the same field:

   > "Copyright in this site and the information set out on it **belonging to our licensors (Tailte
   > Éireann) may not be copied, transmitted or reproduced without their prior consent.** All copyright,
   > trademark and other proprietary notices must be left intact. © Copyright 2011 DHLGH. All rights
   > reserved. **© Tailte Éireann. All rights reserved. Licence No. 2023/OSi_NMA_073**"

3. **`myplan.ie`'s own disclaimer**, verbatim:

   > "Information presented by the Department on this web site is considered public information, copyright
   > of the Government of Ireland and **may be distributed or copied**. Use of appropriate by-line credits
   > is requested. Information from this site **may be used for commercial purposes**; however data may
   > not be further copyrighted without agreement with the Department. **For full details of conditions of
   > use please see map viewer splash screen.**"

The first is a bare grant. The second is an aspiration (`where possible`) beside an all-rights-reserved
clause naming the national mapping agency as an upstream licensor. The third is a different grant again,
and it points at a splash screen inside a map application for the operative terms — which were not
retrieved (§10). **Reported as a contradiction, not resolved.** Resolving it is counsel work. Until it is,
this record does not assert that the layer may ship at `tier: shipped`; §7.1 says what that means for the
pilot.

**What the Department declines to say**, verbatim from the same `licenseInfo`, and it is the same shape as
the Environment Agency's property-level refusal in the flood and erosion surveys:

> "Myplan.ie data are **not published here as legal definitions** of the current actuality with regard to
> Local Authority zoning or their geographic extents. Myplan.ie uses a **generalised, homogenised version**
> of Local Authority data. **Original data should be sourced directly from the relevant Local Authority.**"

**Local publication continues alongside it.** Limerick City & County Council publishes its own
`lap_zoning` layer through its own GeoServer with WMS, WFS-GeoPackage and WFS-GeoJSON resources, licensed
CC-BY-4.0 on `data.gov.ie` (record `lap-zoning`, read 2026-08-27). So the national layer is a second
publication of local records, not the only one — which is what makes the Department's "complements rather
than replaces" sentence a description of reality rather than a disclaimer.

### 2.8 EU level — INSPIRE obliges a vocabulary, and the central index it was browsed through is gone

All facts read **2026-08-27**. The issue asked what member states actually publish centrally against the
Reportnet-style pointer problem the flood survey found. **The obligation is stronger than expected on
vocabulary and weaker than expected on data, and the instrument that would have answered the coverage
question was retired eight weeks ago.**

**The obligation.** Directive 2007/2/EC Annex III item 4, verbatim (retrieved from the Publications Office
CELLAR at `http://publications.europa.eu/resource/celex/32007L0002`, HTTP 200, 142,075 bytes, because
`eur-lex.europa.eu` answers a non-browser client with **HTTP 202** and a WAF challenge):

> "**4. Land use** — Territory characterised according to its **current and future planned** functional
> dimension or socio-economic purpose (e.g. residential, industrial, commercial, agricultural, forestry,
> recreational)."

"current and future planned" carries the existing/planned split at Directive level, so zoning is inside
the theme by the Annex text rather than only by the later specification. The binding implementation is
Commission Regulation (EU) No 1089/2010 Annex IV §4, whose definitions are verbatim:

> "(5) 'planned land use' means spatial plans, defined by spatial planning authorities, depicting the
> possible utilization of the land in the future."

> "(7) '**zoning**' means a partition where the planned land use is depicted, making explicit the rights
> and prohibitions regarding new constructions that apply within each partition element."

The Technical Guidelines (D2.8.III.4 v3.1.1, 2024-07-31, 16,706,807 bytes, 329 pages, CC-BY 4.0) bound it
twice: "Only the spatial planning documents that are or have to be legally adopted by an authority and are
opposable to third parties are considered within INSPIRE", and — the sentence a consumer most needs —
"**Although the original planned Land Use documents are legally binding the derived INSPIRE dataset is
not.**"

**HILUCS is a real international land-use vocabulary, and it is binding.** The Hierarchical INSPIRE Land
Use Classification System has **three levels and 98 values — 6 at level 1, 27 at level 2, 65 at level 3**
(measured from the authoritative register,
`https://inspire.ec.europa.eu/codelist/HILUCSValue/HILUCSValue.en.json`, HTTP 200, 294,687 bytes), with
governance level **"Legal (EU)"** and extensibility **"none"**. Its six top-level classes are
`1_PrimaryProduction`, `2_SecondaryProduction`, `3_TertiaryProduction`,
`4_TransportNetworksLogisticsAndUtilities`, `5_ResidentialUse`, `6_OtherUses`. Assignment is mandatory,
Reg. 1089/2010 Annex IV §4.8(1):

> "Any Land Use data sets **shall** assign to each polygon, pixel or location a land use type from the
> Hierarchical INSPIRE Land Use Classification System (HILUCS) at the most appropriate and detailed level
> of the hierarchy."

**And it is a one-way generalisation, not a crosswalk.** Three facts settle that, and each is from the
binding text or the specification:

1. **The national category is voidable.** In the `ZoningElement` attribute table, `hilucsLandUse` is
   mandatory while **`specificLandUse` — "Land Use Category according to the nomenclature specific to
   this data set" — is `voidable`**. A conforming dataset may carry the harmonised code and omit the
   local one.
2. **The EU-side code list for national categories is empty by design.** `LandUseClassificationValue`,
   verbatim: "This CodeList is **empty in the INSPIRE context** and must be extended by each data
   provider in their national codeList register." Extensibility: `any`.
3. **The mapping lives in national registers, and the requirement is only to document it.** §5.3.1.1.1:
   "Any well-defined and stable classification system defined at a national or infra-national level shall
   be stored in a register managed by the member states… only **the correspondence between the national
   codes and the HILUCS code shall be documented**." The next paragraph downgrades it to Recommendation 7.

**The part of a plan that carries the actual building restrictions is admitted to be unharmonised.**
`SupplementaryRegulationValue` has extensibility `any` against `HILUCSValue`'s `none`, and the
specification says so plainly: "**Further work is though needed for achieving a European harmonisation on
that matter**."

**Four escape hatches bound the whole obligation**, all verbatim from the specification: "INSPIRE does not
require collection of new data"; "There is no specific guidance required with respect to data capture";
"**No minimum data quality requirements are defined for the spatial data theme Land Use**"; and

> "the local governments being at the lower level of administration in any member state will have to make
> available their spatial plan **only if a law imposes the responsibility on them to produce such spatial
> plans**."

**The central index is gone.** `https://inspire-geoportal.ec.europa.eu/overview.html?view=themeOverview&theme=lu`
returns **HTTP 301 to `https://data.europa.eu`**, as does every geoportal path tested. From the
announcement dated 2026-06-22, verbatim: "From 1 July 2026, INSPIRE datasets will be searchable and
accessible through the European Data Portal… **As part of this transition, the INSPIRE Geoportal will be
retired on 1 July 2026.** […] Further filtering of INSPIRE datasets will also be added to the
functionalities." **The theme filter is named as future work**, so the question "how many Land Use
datasets are registered, by country" currently has no first-class instrument.

**Counted through the replacement's SPARQL endpoint, the number is real and means something other than
coverage.** Datasets carrying `dcat:theme = http://inspire.ec.europa.eu/theme/lu`: **410,895** — against
Cadastral parcels 8,299, Land cover 5,107, Hydrography 4,949, Addresses 1,992, Administrative units 1,169.
A fifty-to-four-hundred-fold outlier is a reason to re-measure, and the re-measurement explains it. By the
keyword the Regulation mandates: **`PlannedLandUse` 267,072 against `ExistingLandUse` 22**. By source
catalogue: **`gdi-de` (Germany) 162,856**, Poland's `podgik` 2,792, Spain's `idee` **5**. Germany's own
national catalogue independently returns 202,911 records for `*PlannedLandUse*`, so two unrelated
instruments agree.

**One sample record explains the entire distribution**, verbatim:

> "INSPIRE-Dienst für den Bebauungsplan XPlanung-Dienst für den Plan Baulinien Rindelbach Rattstadt Am
> Ortsweg Nr. 5 (XPlanGML 5.0.1)"

That is one registered dataset for **the building lines of a single street**. Germany registers one INSPIRE
record per municipal plan, so 410,895 measures German metadata granularity rather than European coverage.

**Member-state tests, measured.** This is the Reportnet-style pointer problem, and it takes six different
shapes:

| member state    | central planned-land-use geometry?                  | measured                                                                                                                                                                                                                   |
| --------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Netherlands** | **partial** — bulk GML and WMS, **no WFS anywhere** | `land_use.gml` **8,780,264,029 bytes**; `inspire-planned-land-use.gml` **28,748,757,324 bytes**; all five candidate WFS/OGC-API paths **404**; the DSO APIs return **401**                                                 |
| **Spain**       | **yes**, national plus a stronger regional layer    | SIU national WFS 2.0.0 `numberMatched="21791"` land classes; bulk shapefile 300,691,988 bytes, no authentication; Catalonia's `MUC_QUALIFICACIONS` **546,696**                                                             |
| **Finland**     | **yes, central — and nearly empty**                 | Ryhti OGC API Features, no key: **5,635** detailed plans and 647 master plans, spanning **39 of 309 municipalities**; regional plans absent entirely                                                                       |
| **Germany**     | **no national geometry**                            | 566,042 `*Bebauungsplan*` and 194,403 `*XPlanGML*` metadata records pointing at municipal services; a nationwide query returns **0**; Land-level aggregation works (Baden-Württemberg 31,537, Hamburg 3,044, Berlin 2,844) |
| **Poland**      | **partial** — a national WMS view, no WFS           | sending `service=WFS` to the national endpoint returns a **byte-identical WMS response**                                                                                                                                   |
| **Czechia**     | **no national aggregation established**             | `inspire-lu-wfs` → **404**; the national registry holds planning _records_ rather than geometry                                                                                                                            |

**Licences differ within a single member state, on a single dataset.** For the Dutch services the WMS
capabilities declare `<AccessConstraints>https://creativecommons.org/publicdomain/zero/1.0/deed.nl</AccessConstraints>`
while the Atom feed for the same dataset declares `<rights>http://creativecommons.org/publicdomain/mark/1.0/deed.nl</rights>`,
and for a third service the WMS says CC0 while its Atom says **CC BY 4.0**, which imposes attribution.
Spain requires citation of the source; Finland is CC BY 4.0; Berlin is `Datenlizenz Deutschland – Zero –
Version 2.0` while Baden-Württemberg is `dl-de/by-2-0`, which requires a source notice; Poland's
capabilities declare `<Fees>Brak opłat / none</Fees>`. **There is no such thing as a single licence for
"European zoning".**

**The German legal position is the general case, and the responsible body states it.** XPlanung is binding
by IT-Planungsrat Beschluss 2017/37 of 2017-10-05, and the Leitstelle's own words explain why that does
not produce data: „das Gremium kann jedoch nicht die Länder darauf verpflichten, dass der Datenaustausch
in Planungs-, Genehmigungs- und Bauprozessen zwingend digital zu erfolgen hat… Beschlüsse des IT-PLR
entfalten nur ihre Wirkung, wenn Daten (Planwerke) bereits digital vorliegen" — the body cannot oblige the
Länder to exchange digitally, and its decisions take effect only where plans are already digital.

**The inversion worth carrying out of this section:** Finland mandates _submission of data_ to a national
register and its central endpoint holds 12.6 % of municipalities, with the statutory duty deferred to
2029-01-01; Germany mandates the _exchange format_ and has near-complete data that is nowhere central.
Neither produces a retrievable European layer.

**Two measurement traps found here**, both of the shape this repository keeps recording — a confident
wrong answer indistinguishable from a real absence:

1. **`data.europa.eu`'s search API silently ignores its `facets` parameter.** `{"country":["de"]}`,
   `{"keywords":["PlannedLandUse"]}` and a deliberate nonsense key `{"bogusfacet":["zzz"]}` all return the
   identical full-corpus count of **1,893,030**. The control key is what caught it; any per-country figure
   taken from that API is fabricated.
2. **A SPARQL exact-literal keyword match returns zero for a keyword that is present.** `?d dcat:keyword
"PlannedLandUse"` returns **0**, while `FILTER(STR(?k) = "PlannedLandUse")` returns **267,072** — the
   literals are language-tagged. The zero reads as "nobody publishes planned land use", which is the
   interesting-sounding wrong answer.

**One defect in the authoritative register, found by reading it rather than the specification.** The
`1_PrimaryProduction` definition is an orphaned rider clause — it says what is _additionally included_
("Areas where the manufacturing industries aggregate, package, purify or process the primary products
close to the primary producers are included…") and never states what primary production **is**. Every
sibling class carries a head definition and its own children are coherent. The specification's normative
Annex C does not enumerate the values at all — it defers to the register — so there is no second copy to
read. Anyone building against HILUCS needs a hand-written definition for that one class.

### 2.9 The observed-use contrast class — OSM, Overture, and the land-cover products

All facts read **2026-08-27**. These are not zoning sources. They are here because they are what a
consumer reaches for when zoning is absent, and because §5's rule exists to keep them out of a zoning
answer.

**OpenStreetMap records observed ground use, and its own documentation forbids the reading that would
make it zoning.** From `Tag:landuse=residential`, under the heading `When not to use`, verbatim:

> "This tag should only be used for areas dedicated to and actually used for residential purposes. It
> should not be used […] **for areas zoned as residential by local development plans, and not yet used as
> residential area**"

and from the same page's image caption:

> "This area is `landuse=farmland` - **even if local government zoned it for residential construction and
> construction is planned in future**"

The governing doctrine is verifiability — "A tag/value combination and geometry is verifiable _if and only
if_ **independent users observing the same feature would make the same observation every time**" — and
`Good practice` states the boundary in one line: **"OSM is a geographic database, not a legislational
database."** A zoning designation fails verifiability by construction: it is a fact about an ordinance,
and two mappers standing on the parcel cannot observe it.

**There is no OSM zoning scheme, and that was measured rather than assumed.** The wiki page `Zoning` is a
redirect (`#REDIRECT [[Parcel]]`), and `Parcel` records an unresolved dispute — "No widely accepted
consensus exists on whether or not parcel boundaries and associated parcel attributes should be made
available in OSM… **No detailed proposals for tagging parcel data appear to have been put forward.**" A
taginfo query for keys matching `zone` returns **311 keys**, and the top ones are `zone:traffic`
(782,123), `zone:maxspeed` (404,615), `surveillance:zone` (292,803) and transit fare zones. **Not one is a
land-use zoning designation.** The nearest thing in the global database is `bakersfield:zone` at 1,028
uses — a single-city import artifact.

**Coverage measured for two US cities**, by administrative boundary rather than by a bounding box, with a
point-grid coverage test rather than a polygon-area sum (which double-counts, because OSM sanctions
nesting):

|                                                | Philadelphia PA (`rel/188022`) | Phoenix AZ (`rel/111257`) |
| ---------------------------------------------- | -----------------------------: | ------------------------: |
| `way["landuse"]` + `relation["landuse"]`       |                      **3,930** |                **11,403** |
| distinct `landuse` values                      |                             31 |                        33 |
| boundary area                                  |                     368.80 km² |              1,345.30 km² |
| **share of the city inside a landuse polygon** |                    **16.08 %** |               **48.60 %** |

The coverage figure is stable under a fourfold grid-density change (16.08 % at a 100 m grid, 16.00 % at
50 m), so it is not a sampling artifact. **The two cities differ by a factor of three**, which is the
finding: community landuse coverage is a property of whichever local mapping community showed up, not of
OSM.

**Counting polygons reports the wrong thing.** In Philadelphia `landuse=grass` is 54.1 % of polygons and
10.0 % of area, while `landuse=industrial` is 4.6 % of polygons and 23.2 % of area — and the OSM wiki
itself disclaims `grass`: "At least two of the common values of `landuse` may be viewed as **not strictly
land use**. These are `landuse=grass` and `landuse=forest`."

**Overture carries the same data under a shared schema and the same licence.** Theme **`base`**, type
**`land_use`**, whose schema file states its own provenance: `description: Land use features from
OpenStreetMap`, and `Translates 'landuse' from OpenStreetMap tag`. Required fields are `subtype` (24
values) and `class` (114 values). Overture's attribution page states **"License for theme: ODbL"** for
`base`, so the share-alike obligation follows the data rather than being laundered by the re-publication.
Current release measured by direct bucket listing: **`2026-08-19.0`**, with
`s3://overturemaps-us-west-2/release/2026-08-19.0/theme=base/type=land_use/` holding **32 objects
totalling 18,686,303,456 bytes**.

**This repository's Overture path does not carry it.** A census of `theme=` string literals across the
whole tree (excluding `node_modules` and `out/`) returns **six occurrences over three themes** —
`theme=divisions` (3, in `packages/mailwoman/gazetteer-pipeline/admin/fold-overture.ts`), `theme=places`
(2, in `.../poi/build-poi.ts`), and `theme=addresses` (1). **There is no `theme=base` reference anywhere,
so the existing ingestion path carries no land-use theme at all** and adding one would be new work, not a
configuration change.

**Three land-cover products are routinely confused with zoning**, and each is a raster with no notion of a
parcel or an ordinance:

- **USGS Annual NLCD** — 30 m, 16 classes, 1985–2025, "no restrictions on the use of science products". A
  "Developed, Medium Intensity" pixel describes measured impervious surface, never a district.
- **USDA Cropland Data Layer** — annual, 30 m through 2023 and **10 m from 2024**. NASS states that "The
  accuracy of the CDL non-agricultural land cover classes are entirely dependent upon the NLCD", so in the
  urban areas where zoning questions live it is at its weakest by the agency's own statement.
- **NOAA C-CAP** — coastal only, 30 m regional and 1 m high-resolution, up to 25 physical cover classes.

### 2.10 The classification standards that exist, and why neither is a zoning crosswalk

All facts read **2026-08-27**. Before proposing a vocabulary, this survey checked whether one already
exists. **Two do, and both classify observed use rather than legal designation.**

**The APA Land-Based Classification Standards (LBCS)** classify land along **five dimensions**, verbatim
from the standard (p. 2): "For local planning purposes, LBCS calls for classifying land uses in the
following dimensions: **activity, function, structure type, site development character, and ownership**."
Each is a separate four-digit code, and "every record in the database is classified in not just one
land-use field, but several—one for each dimension."

**It is not a zoning crosswalk, and that was measured.** In the 163-page normative standard
(`LBCS.pdf`, HTTP 200, 489,655 bytes) **the string `zoning` appears three times, all incidental**. In the
26,120,192-byte terms database, `zoning` appears **3 times** and `crosswalk` **zero**, while `SIC` appears
27 times and `NAICS` four — **LBCS cross-links to economic classification, not to zoning.** Its Activity
dimension is defined as "An observable characteristic of land based on **actual use**." INSPIRE's own
review of it agrees: "Because of the different dimensions a very detailed and accurate picture of **the
actual land use** can be made."

**It is also frozen and not redistributable.** Every one of the standard's **163 page footers carries the
identical date `01-Apr-2001`**, and the machine-readable databases carry internal timestamps of
**2009-12-23 and 2009-12-26**, distributed only as legacy Microsoft Access `.mdb`. APA's copyright page,
verbatim:

> "**You may not copy, distribute, or transmit material from this website without the prior written
> permission of APA** or the original copyright owner, except that you may download, view, and print one
> copy for your personal, noncommercial use only"

**The 1965 Standard Land Use Coding Manual** is the only unambiguously redistributable candidate, being a
US Government work — and it is the most obsolete. Its own subtitle places it on the observed-use side: "A
Standard System for Identifying and Coding **Land Use Activities**". APA describes LBCS as the project
begun "to update the 1965 SLUCM".

**No published crosswalk maps LBCS to HILUCS.** The INSPIRE Land Use data specification's Appendix D.1.7
reviews LBCS as a candidate model and rejects it — "**LBCS model is a bit confusing and not simple in
use**", "**Overall there is too much detail and the whole system is too complex**" — and the document
carries no correspondence table between them.

**The one organisation performing zoning-district-to-shared-category mapping at national scale reduced the
vocabulary to three values.** The National Zoning Atlas's `Type of Zoning District` field takes
`Primarily Residential`, `Mixed With Residential` and `Nonresidential`, with all fidelity moved into about
200 per-district measured characteristics. Its own framing of the problem, verbatim: "**Zoning is
decentralized, inconsistent, and convoluted.**" And on whether the reading can be automated:

> "Not the code reading part! **Algorithms simply cannot (yet) understand the nuances of lengthy, complex
> zoning codes to the level of accuracy we require.** (We've tried since 2022…)"

The one commercial operator doing it describes the same method. Regrid, verbatim: "we convert each
County's usecode **or zoning code** when they make them available, to the closest corresponding
Standardized Land Use Code **manually**." Note that its input is an assessment use-code _or_ a zoning
code interchangeably — which conflates the exact distinction §2.1 draws.

### 2.11 Deliberately not surveyed

- **Member states other than Ireland, beyond the six tested in §2.8.** Each publishes under its own terms
  with its own vocabulary; none was verified and none is claimed.
- **Canada, and every country outside the US and the EU.** Canadian records appeared repeatedly in the
  catalogue sampling (§2.6) and were set aside rather than followed.
- **Building codes, overlay districts as a subject of their own, and historic-district designations.**
  Different instruments with different authorities, and INSPIRE's own admission that the
  supplementary-regulation vocabulary is unharmonised (§2.8) is the warning about treating them as one.
- **Parcel and cadastral data.** A zoning polygon is not a parcel, and joining them is a second acquisition
  program with its own licensing.
- **Assessment use-codes as a source.** They are a near-neighbour that answers a different question, and
  §2.1's Florida rule is why they are named and excluded rather than ignored.
- **The zoning ordinance text itself.** The layer carries designations, not rules. Reading a code to
  extract permitted uses is the National Zoning Atlas's programme, and its own statement that algorithms
  "cannot (yet)" do it is the reason this survey does not propose it.

### 2.12 The inventory, side by side

|                         | **IE — GZT (the pilot)**                                        | **US — National Zoning Atlas**                    | **US — state layers**                                    | **US — county/municipal**                          | **EU — INSPIRE PLU**                                        | **OSM / Overture `land_use`**                       |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| subject (§2.1)          | zoning                                                          | zoning                                            | zoning, future land use, or neither                      | zoning                                             | planned land use                                            | **observed land use**                               |
| provenance grade (§5)   | `authoritative`                                                 | `inferred` — a research assembly                  | `authoritative`                                          | `authoritative`                                    | `authoritative`                                             | `inferred`                                          |
| what it is              | 30 local authorities' adopted plans, republished nationally     | jurisdictions read and normalized by analysts     | 18 states checked; 12 publish something statewide        | one jurisdiction each, ~33,000 of them             | a binding vocabulary over national publication obligations  | community observation of ground use                 |
| licence                 | **three statements that disagree** (§2.7)                       | **redistribution and commercial use prohibited**  | null, empty, or restrictive — see §7.2                   | **85 % empty `licenseInfo`**; 1 open licence in 21 | at least four families; two within one Dutch dataset        | **ODbL**, share-alike                               |
| vocabulary              | 560 local codes **and** 54 declared generic types, side by side | 3 district-type values + ~200 characteristics     | local codes, or a generalization with no local code (MD) | 16 different field names, often no description     | HILUCS, 98 values, 3 levels, closed; national code voidable | `subtype` 24 / `class` 114                          |
| coverage                | 30 of 31 authorities; **96.76 %** of population                 | 11,015 of 33,295 jurisdictions; **65.68 %**       | **18.90 %** of US population at best, 10 acquisitions    | one jurisdiction each                              | no pan-European statement; the central index is retired     | 16.1 % of Philadelphia, 48.6 % of Phoenix           |
| acquisition             | one download, 247,452,342 bytes, 41.1 s                         | none — no bulk, no API, DOI resolves to a web map | one service per state                                    | one service per jurisdiction                       | six architectures across six member states                  | Overpass, or 18.69 GB of Parquet                    |
| reachable from this lab | **yes**, measured end to end                                    | web map only; the API returns 403                 | mostly; 40 % of sampled services fail anonymously        | mixed; several 403 or 200-with-an-error-body       | mixed; NL has no WFS, PL has no WFS, CZ 404                 | **yes**                                             |
| usable for this layer   | **yes — the pilot, at `build-local`**                           | **no**                                            | **not yet** — §7.2's threshold                           | **no** — the acquisition cost is the programme     | **no** — no retrievable European layer                      | **no** — a different question and a different grade |

## 3. Coverage honesty per source

### 3.1 The claim a coverage row is allowed to make

`CoverageBasis.Designated` means "An authority declares the set complete for this cell". The set a
planning authority declares complete is **its own adopted plan**, not the world's land regulation. So the
strongest claim this layer can support is

> the authority's adopted plan assigns this zoning designation to the location, under this plan and
> during this plan's stated window

and never

> this is what may be built here.

The distinction is not a nicety. The Department of Housing, Local Government and Heritage says the second
reading is wrong in its own metadata: "Myplan.ie data are **not published here as legal definitions** of
the current actuality with regard to Local Authority zoning or their geographic extents… **Original data
should be sourced directly from the relevant Local Authority.**" That is the same shape as the
Environment Agency's property-level refusal in the flood and erosion surveys, and it has to survive into
the observation's wording rather than living only in this document.

**A plan is part of the claim, not a parameter of it.** A zone exists inside a named Development Plan or
Local Area Plan with a stated validity window. A layer that dropped the plan and kept the zone would be
answering a question no authority asked.

### 3.2 The inversion — an absent zoning polygon is almost never "unzoned"

This is the erosion survey's inversion, and zoning is the sharper case of it.

For flood zones, England-wide coverage is stated and Zone 1 is _defined as the absence_. **For zoning
there is no such definition anywhere.** A location with no zoning polygon is one of at least four
entirely different things, and no published product distinguishes them:

1. **Outside any adopted plan area** — most land in most countries. The authority has said nothing.
2. **Inside a plan area but on land the plan does not zone** — a designation of a kind, but not one the
   layer can read.
3. **In a jurisdiction that has never adopted zoning at all.** This is a real category, not a hypothetical:
   the National Zoning Atlas's own data records Colorado as having 334 potential zoning jurisdictions of
   which **59 have declined to zone**, and Hawaii as vesting zoning in **5 counties only**.
4. **In a jurisdiction whose records nobody has read or published yet.** This is the largest category in
   the United States by a wide margin (§7.2).

**And the source can distinguish one of them, which proves the rest are absences rather than
designations.** Ireland's layer carries `ZONE_ORIG = "UNZ - Unzoned"` with `ZONE_GZT = "N/A"` on **4 of
85,330 rows**. The authority states "unzoned" as a positive value where it means to. Every other absence
is a row that is not there, and it means one of the four things above.

**So a builder that copied the flood layer's rule would convert "nobody has published this" into "no
restriction applies here"**, over most of the map, in a domain where a reader would act on it. The pilot
therefore writes `CoverageBasis.SourcePresent`, `supportsExclusion` is false, and no negative claim is
licensed.

**One further limit the coverage row cannot express.** The Department states "Awaiting data for some Local
Authorities - please see map viewer for coverage details", and the detail is published only inside a map
application. Donegal's absence was recovered by measurement (§2.7), not read from a coverage statement.
Deriving a mapped footprint from the union of the zoning polygons is forbidden for the same reason the
flood survey forbids it: the union of zoned areas is not the area the authority examined, and the
difference is the whole content of a negative answer.

### 3.3 Two denominators, two numbers, and neither substitutes for the other

The issue asked for a coverage fraction with its denominator. **There are two fractions here and they
differ by an order of magnitude**, so this record states both and keeps them apart.

**Denominator A — people living in a covered jurisdiction.** For Ireland: **4,982,055 of 5,149,139 =
96.76 %**, the missing authority being Donegal County Council (Census 2022, CSO table `FY003A`). This
says a zoning product exists for the place you live. It does **not** say a zoning polygon covers your
address.

**Denominator B — land carrying a zoning polygon.** Measured for Ireland, and the measurement contains a
trap that reverses how it reads. The sum of `Shape__Area` over all 85,330 features is **5,444.5 km²** —
and **2,232.1 km² of that, 41 %, is a single polygon**: Meath County Council's `RA - Rural Area`, which
zones the county's whole rural remainder. The next largest polygon in the country is **32.5 km²**, a
factor of 69 smaller. Meath zones its whole territory; most authorities zone settlements only.

**So zoned area is not a coverage measure of anything**, and one authority's drafting convention moves the
national figure by 41 %. This record reports the area and declines to convert it into a coverage
percentage. (The national land-area denominator was also not established from a primary source — §10.)

The same split governs the US numbers in §7.2, and it is why that section's answer is a threshold rather
than a percentage.

## 4. The vocabulary decision

### 4.1 What was measured

The issue asked whether to carry jurisdiction-local codes verbatim or to author a crosswalk. **Ireland is
a natural experiment on that question**, because a national authority already built the crosswalk, over
one small country, with statutory access to the plans. Measured 2026-08-27 against the live service:

| measurement                                                           | value                                                                               |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| distinct local zone strings (`ZONE_ORIG`) across 30 local authorities | **560**                                                                             |
| the same, after trimming and case-folding                             | **555** — the difference is five strings colliding only on case or a trailing space |
| distinct national generic types (`ZONE_GZT`) observed                 | **55**                                                                              |
| generic types declared in the service's own coded-value domain        | **54** — `N/A` is used on 4 rows and is **not in the declared domain**              |
| local codes per authority                                             | min **10** (Monaghan), median 21, max **85** (Kildare)                              |
| distinct `(authority, local code)` pairs                              | **772**                                                                             |

**So one small country's 30 authorities produce 560 distinct zone labels for 55 generic types.** That is
the size of the vocabulary problem at the low end — one country, one language, one national curator.

**The decisive measurement is that the crosswalk is not a table.** If a local code determined a generic
type, the mapping could be shipped as a lookup and the local column would be redundant. It does not:

- **51 of the 772 `(authority, local code)` pairs take more than one generic type inside a single
  authority.** Cork County Council's `Residential` maps to **7** different generic types — `R1`, `R2`,
  `R3`, and also `G3` (conservation, amenity or buffer space), `G5`, `N1.6` and `S5`. Its `Special Policy
Area` maps to **14**. Clare's `Utilities` maps to **11**.
- **A further 24 local codes are consistent inside each authority and diverge across them** — `Commercial`,
  `District Centre`, `Enterprise`, `Low Density Residential`, `Neighbourhood Centre`, `Mixed Use Zoning`.

The mapping is therefore **per polygon, authored by a person reading a plan**, and it cannot be
reconstructed from the pair of columns. That is the same conclusion the two organisations doing this at
US scale reached independently: the National Zoning Atlas says outright that "Algorithms simply cannot
(yet) understand the nuances of lengthy, complex zoning codes to the level of accuracy we require", and
Regrid says its conversion is done "**manually**".

**The local code alone is unreadable, which is why the crosswalk earns its place.** South Dublin's 16
local codes are `RES`, `OS`, `SDZ`, `EE`, `RU`, `REGEN`, `RES-N`, `VC`, `LC`, `HA-DM` and six more.
Nobody outside South Dublin can read them, and they collide with other authorities' codes for other
meanings.

**And the crosswalk alone is lossy, which is why the verbatim code earns its place.** 560 labels
collapsing to 55 types discards, among other things, the difference between South Dublin's `RES` and
`RES-N`, which the authority itself keeps.

**One further measurement, because two crosswalks would be worse than one.** Ireland ships a second
national code, `SZO` (Standardised Zoning Objective), 22 distinct values. Grouping `ZONE_GZT` against
`SZO` returns 55 distinct pairs: **no generic type maps to more than one `SZO`**, while **8 of the 22
`SZO` values span more than one generic type** (`TU` covers all 17 network codes; `RU` covers all six
primary-sector codes). So `SZO` is a strict coarsening of `ZONE_GZT`, not a competing opinion — and it is
carried as published rather than derived, because the roll-up could change.

### 4.2 The decision

**Carry the jurisdiction's own code verbatim, always. Carry a crosswalk only where the publishing
authority ships one, as a separate column with its own provenance, never as a replacement. Author no
crosswalk of our own.**

Four reasons, in the order they bind.

1. **No maintained, redistributable standard exists to adopt** (§2.10). LBCS classifies observed use, has
   not been revised since 2001, and may not be copied or distributed without APA's written permission.
   SLUCM is public domain and sixty-one years old, and is also about observed use. There is no LBCS-to-
   HILUCS crosswalk. Adopting either for zoning would relabel a legal instrument as an observation.
2. **Authoring one would be authoring zoning judgment**, which the issue puts out of scope and which this
   project's discipline forbids anyway. The measurement above shows the judgment is per polygon: 51
   `(authority, code)` pairs prove that no code table could carry it, so "authoring a crosswalk" means
   adjudicating 560 vocabularies parcel by parcel. That is the National Zoning Atlas's whole programme,
   it has taken 1,337,510 pages of reading, and it is not something a geocoder does on the side.
3. **The authority's own crosswalk is a fact about the authority**, and repeating it is what this layer
   does. Ireland's Department published the generic type and said, in the item description, that it
   "**complements (rather than replaces) the existing statutory zoning used for each individual plan**".
   Carrying both columns is not a compromise between two designs — it is a transcription of what the
   publisher did.
4. **A reduction that keeps the original is reversible; one that discards it is not.** If a consumer later
   needs a coarse rollup and the authority ships none, the National Zoning Atlas's three published values
   are the defensible shape to copy — and copying the _shape_ is free, where copying their _data_ is not.

**The builder consequences.** The declared domain is carried as a closed set and an undeclared value
**throws**, because an unknown code is a source-schema change and that is the event a reader most needs
to hear about — except that Ireland's own data already violates its own domain on 4 rows (`N/A`), so the
ingest must carry the service's domain **plus** the values observed in the data, and report the
difference rather than coerce it. Store the source string; compare case-insensitively; never normalize the
stored value. `LA_CODE` carries `Fl` for Fingal against `CL`, `CO`, `DU` for the rest.

## 5. The mixed-provenance rule

### 5.1 The rule

**A cell's zoning claim carries exactly one provenance grade, and the two grades never merge.**

- `authoritative` — the publishing body is the planning or legislative authority for the land, or a
  government body republishing that authority's own records. Ireland's Department of Housing, Local
  Government and Heritage republishing a local authority's adopted plan is authoritative; so is the local
  authority's own service.
- `inferred` — an observation, a community mapping project, a research assembly, or any reading of the
  land that was not adopted as the plan. OpenStreetMap `landuse` is inferred. Overture's `base/land_use`
  is inferred, because it is the same data. A land-cover raster is inferred.

Neither grade is better; they answer different questions (§2.1). The rule is that **a query answered from
an `inferred` row may never be presented as the authority's designation**, and no reader may reach a
zoning conclusion by mixing the two.

**This is `packages/filer/`'s discipline, applied unchanged.** `FilerEdgeAssertion` grades an assertion
`Authoritative` or `Inferred`; its schema keeps them in separate columns from what the assertion _means_;
and a `CHECK` constraint enforces the direction, because — verbatim from `packages/filer/schema.ts` — "a
score may appear ONLY on an inferred row, since an authoritative membership matched nothing and any
number there would be a fabricated confidence." The same three mechanics carry over: the grade is a
column rather than a convention, a blank grade is rejected (`NOT NULL` alone would accept `''`, and a
blank matches neither half of every read that splits on strength), and the two never merge in a rollup.

### 5.2 The measurement that makes it a constraint rather than a preference

Both sources were read for the **same jurisdiction on the same day**, so the comparison is about the
question each answers rather than about vintage.

South Dublin County Council, 2026-08-27. The authority publishes **5,478 zoning polygons** over 16 local
codes. OpenStreetMap holds **6,714 `landuse` features** over **30 distinct values** in the same
territory (Overpass `timestamp_osm_base` 2026-08-27T20:11:06Z), of which the largest single class is
**`grass` at 2,486 features (37.0 %)** — a ground cover that no planning authority issues.

Taking the **1,652 OSM `landuse=residential`** polygons and asking the authority what it zones at each
polygon's centroid:

| what the authority says at that location       | polygons |      share |
| ---------------------------------------------- | -------: | ---------: |
| **no zoning polygon at all**                   |  **249** | **15.1 %** |
| `R2` Existing residential                      |      519 |     31.4 % |
| **`P1` Agriculture**                           |  **387** | **23.4 %** |
| **`G3` Conservation, amenity or buffer space** |  **324** | **19.6 %** |
| `G1` Open space, park                          |       68 |      4.1 % |
| `C2.1` Industrial, enterprise, employment      |       25 |      1.5 % |
| `M2` City/town/village centre                  |       21 |      1.3 % |
| `R1` New/proposed residential                  |       21 |      1.3 % |
| `R3` Residential, mixed                        |       18 |      1.1 % |
| `M1`, `M3` mixed use                           |       20 |      1.2 % |

**Only 558 of the 1,652 — 33.8 % — sit on land the authority zones residential.** A reader who took
`landuse=residential` as a proxy for residential zoning would be wrong about two polygons in three, and
the two largest wrong answers are agriculture and conservation.

**This is not OSM being wrong.** It is OSM answering the question it says it answers, and its own wiki
forbids the substitution in as many words: `landuse=residential` "should not be used… for areas zoned as
residential by local development plans, and not yet used as residential area". The divergence is the
expected consequence of a category difference, and the number is here so the rule is grounded rather than
asserted.

Two caveats on the method, stated because they bound the number: a centroid is one point, so a large OSM
polygon spanning several zoning polygons is credited to one of them; and no centroid fell inside two
zoning polygons, which is consistent with the authority's zones forming a partition.

### 5.3 What the schema does about it

- **`provenance_grade` is a `NOT NULL` column on every zoning row**, over `{authoritative, inferred}`,
  with a `CHECK` rejecting the empty string.
- **`source` is not a proxy for the grade** and is carried separately — the filer precedent's reason
  applies directly here: one publisher can emit both grades, as Overture does across its themes.
- **One artifact holds one grade.** An `inferred` land-use layer is a **different database with a
  different `layer_manifest.name`**, because `layer_coverage.observed_rows` is defined as "rows this layer
  actually holds in the cell" and coverage measured over OSM polygons cannot describe an authority's
  zones. This is the same reasoning that made the exclusion-grade coverage pilot build its own artifact
  rather than write into the shipped `poi.db`.
- **The licences make the separation compulsory anyway.** OSM and Overture `base` are **ODbL**, and ODbL
  §4.4(b) is explicit that "Extraction or Re-utilisation of the whole or a Substantial part of the
  Contents into a new database **is a Derivative Database** and must comply with Section 4.4." §4.5(a)
  does not rescue a merged table: a _Collective_ Database is defined as this database "in unmodified form
  as part of a collection of independent databases", which covers shipping ODbL data **alongside** other
  data, not merging its rows into a joint schema. §4.5(b) is the route that does work — query _output_ is
  a Produced Work and creating one does not create a Derivative Database — so an observation that
  _answers from_ an ODbL layer carries the §4.3 attribution obligation and not share-alike. **Merging an
  ODbL land-use row into a CC-BY zoning table would relicense the zoning table.**
- **A response never mixes grades in one claim.** Where both layers are attached, the observation reports
  the authoritative designation and the observed use as two labelled statements with two attributions, or
  it reports only the one it has.

## 6. The layer schema sketch

### 6.1 Which storage shape applies

Zoning is polygon data, so **the polygon rule from the inherited size contract applies**: the authority's
unsimplified rings are the truth table, an H3 cell table classifies containment above it, `compactCells`
collapses uniform interiors, and the resolution is picked from measurement. §6.4 records the one place
that contract's own decision procedure does not reach for this subject, and what replaces it.

### 6.2 Tables

Seven domain tables plus the two contract tables, written as Kysely schema modules with the typed
interface co-located with its `createXTable`, per the house database discipline.

```
zoning_area                 -- THE TRUTH: one row per authority polygon, plain rowid (it holds a blob)
  area_id           TEXT PRIMARY KEY   -- authority feature id, scoped by plan (see below)
  jurisdiction_id   TEXT      -- the authority that adopted the plan; FK to zoning_jurisdiction
  plan_id           TEXT      -- FK to zoning_plan — the plan this zone belongs to
  local_code        TEXT      -- ZONE_ORIG, VERBATIM, in the authority's spelling. NOT NULL.
  local_description TEXT?     -- the authority's own description of that code
  local_code_url    TEXT?     -- the authority's own link to the plan text
  crosswalk_code    TEXT?     -- ZONE_GZT — NULL where the authority ships no crosswalk
  crosswalk_scheme  TEXT?     -- which crosswalk this is ('IE-GZT', 'INSPIRE-HILUCS', …); NULL with the above
  crosswalk_rollup  TEXT?     -- SZO — a coarser code from the SAME authority, carried as published
  provenance_grade  TEXT      -- 'authoritative' | 'inferred'; NOT NULL, CHECK <> ''
  min_lat, min_lon, max_lat, max_lon  REAL   -- precomputed bbox, the ray-cast prefilter
  ring_count        INTEGER   -- how many rings; with signed_area_m2 it is the ingest's own receipt
  signed_area_m2    REAL      -- the SIGNED ring sum (§2.7 trap b); compared to the source's own area
  rings             BLOB      -- the authority's ring coordinates, UNSIMPLIFIED, with hole roles RESOLVED

zoning_plan                 -- the plan a zone lives inside; a zone without one is not a claim
  plan_id           TEXT PRIMARY KEY
  jurisdiction_id   TEXT
  plan_name         TEXT      -- 'The Fingal Development Plan 2023 – 2029'
  plan_level        TEXT      -- 'DP' | 'LAP' | 'SDZ' — the authority's own vocabulary
  valid_from        TEXT      -- PLAN_FROM
  valid_to          TEXT?     -- PLAN_TO
  superseded        INTEGER   -- the authority's CURRENT_PLAN flag, carried as published
                              -- NOTE: superseded=0 does NOT mean in force today — 2,363 of 85,330
                              -- Irish rows carry a valid_to already in the past (§2.7)

zoning_jurisdiction         -- who adopted the plan, and at what level of government
  jurisdiction_id   TEXT PRIMARY KEY
  name              TEXT
  source_code       TEXT?     -- the publisher's own code, verbatim ('Fl' for Fingal — do not repair)
  wof_id            INTEGER?  -- the spine key where the resolver already knows this place
  country           TEXT

zoning_vocabulary           -- the authority's declared domains, as shipped, per scheme
  scheme            TEXT      -- 'IE-GZT' | 'IE-SZO' | 'IE-LOCAL:SD' | 'INSPIRE-HILUCS' | …
  code              TEXT
  label             TEXT      -- the authority's own words
  definition        TEXT?     -- the authority's own definition, where it is retrievable
  definition_url    TEXT?     -- NULL where it is not; see §2.7 trap (c)
  declared          INTEGER   -- 1 if the source DECLARES this code, 0 if only OBSERVED in the data
  PRIMARY KEY (scheme, code)

zoning_crosswalk_edge       -- the authority's own mapping, WHERE IT PUBLISHES ONE AS A TABLE
  from_scheme, from_code TEXT
  to_scheme,   to_code   TEXT
  authored_by       TEXT      -- the body that authored THIS edge, never us
  PRIMARY KEY (from_scheme, from_code, to_scheme, to_code)
                              -- EMPTY FOR IRELAND: §4.1 measured that the GZT mapping is per POLYGON,
                              -- not per code — 51 (authority, code) pairs take more than one type — so
                              -- the mapping lives on zoning_area and no edge table can carry it.

zoning_cell                 -- the build-time containment index, WITHOUT ROWID
  h3_cell           INTEGER   -- 48-bit short cell at the declared resolution
  area_id           TEXT
  containment       TEXT      -- 'whole' | 'partial'
  PRIMARY KEY (h3_cell, area_id)

zoning_mapped_extent        -- the authority's own statement of what it examined
  extent_id         TEXT PRIMARY KEY
  source            TEXT
  effective_date    TEXT?
                              -- EMPTY IN THE PILOT: §3.2 — the Department publishes its coverage detail
                              -- only inside a map viewer, so layer_coverage carries source_present and
                              -- NEVER a negative claim.

layer_manifest / layer_coverage   -- the contract tables, from @mailwoman/core/layers
```

`WITHOUT ROWID` on `zoning_cell` and not on the geometry tables follows the contract's own guidance:
small fixed-width rows probed by their exact primary key belong in the B-tree; a row carrying a geometry
blob does not.

Three schema points carry a measurement behind them.

- **`local_code` is `NOT NULL` and `crosswalk_code` is nullable**, which is §4.2 expressed as a
  constraint. A source with no crosswalk produces a complete row; a source with no local code does not.
- **`signed_area_m2` is stored as the ingest's own receipt**, because §2.7's ring-orientation trap is
  silent and its check is exact: the signed sum matches the authority's published area, the absolute sum
  does not.
- **`zoning_vocabulary.declared` separates a declared code from an observed one.** Ireland declares 54
  generic types and uses 55; `N/A` appears on 4 rows and in no domain. Folding the two would either hide
  a source-schema change or invent a declaration the authority never made.

### 6.3 Manifest fields

| field                       | pilot value                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `name`                      | `zoning-ie-gzt`                                                                                                |
| `version`                   | the edition ingested, keyed to the layer's own `UPLOAD_DATE` — `2026-06-18`                                    |
| `tier`                      | **`build-local` until the licence contradiction in §2.7 is resolved.** `shipped` needs one grant, not three    |
| `license`                   | the resolved grant, or absent — never a `CC-BY-4.0` claim while an all-rights-reserved clause names a licensor |
| `attribution`               | the Department, and Tailte Éireann where the resolved terms require it                                         |
| `source` / `source_vintage` | ArcGIS item `5c2608ebedd84013aaeff8bf669e8596`, and the item's `modified` date 2026-05-13                      |
| `build_cmd` / `build_sha`   | the invocation and the commit that produced it                                                                 |
| `freshness_policy`          | `versioned-refresh` — the Department re-issues under the same product; there is no published cadence (§10)     |
| `spine_keys`                | `{ h3: { column: "h3_cell", resolution: … } }`, plus `wof_id` on `zoning_jurisdiction` — see §1                |
| `created_at`                | caller-supplied, per the contract                                                                              |

### 6.4 The resolution — and the one place the size contract's decision procedure does not reach

The inherited size contract says the resolution is picked from the measured `partial` share, never
argued. **For this subject that statistic carries no signal, and the reason was measured.**

**Zoning polygons are mostly smaller than a cell.** Computed over all 85,330 Irish features (planar
shoelace in EPSG:2157, signed rings):

| percentile |  p1 |  p5 | p10 |   p25 |   **p50** |    p75 |    p90 |    p95 |     p99 |
| ---------- | --: | --: | --: | ----: | --------: | -----: | -----: | -----: | ------: |
| area (m²)  |   9 | 132 | 317 | 1,258 | **4,497** | 14,991 | 44,432 | 89,755 | 486,787 |

Against H3 average cell areas (h3-js 4.5.0): res 9 = 105,333 m², res 10 = 15,048 m², res 11 = 2,150 m².
**95.7 % of zoning polygons are smaller than an average res-9 cell**, 75.1 % smaller than a res-10 cell,
and 34.5 % smaller than a res-11 cell. So the `partial` share is near 100 % at every candidate and cannot
choose between them.

**Two numbers can, and both were measured on a real authority.** South Dublin County Council, 5,478
polygons, indexed with `polygonToCells` plus a vertex fallback for sub-cell polygons:

| resolution |   cells | candidates per cell (mean / p90 / max) | cells with >1 candidate | **features with no interior cell** |
| ---------- | ------: | -------------------------------------: | ----------------------: | ---------------------------------: |
| **9**      |   2,266 |                          3.02 / 8 / 30 |                  37.2 % |                 **4,756 (86.8 %)** |
| **10**     |  15,189 |                          1.17 / 2 / 12 |                  10.7 % |                     3,116 (56.9 %) |
| **11**     | 102,761 |                           1.01 / 1 / 6 |                   0.5 % |                     1,005 (18.3 %) |

**The right-hand column is the finding, and it is a defect waiting to happen.** At res 9, `polygonToCells`
returns **nothing at all** for 86.8 % of the polygons, because no cell centre falls inside them. **A
builder that indexed only the polyfill output would silently drop five of every six zoning polygons**, and
every dropped polygon would read downstream as "no zoning here" — a well-formed wrong answer at exactly
the question this layer exists to answer.

So this survey's addition to the size contract, for any layer whose polygons are near or below the cell
size:

1. **Index cell-touches-polygon, never cell-centre-in-polygon.** The index is the polyfill **union** every
   cell the ring passes through, and a builder must assert that **no feature ends with zero cells**.
2. **Pick the resolution from candidates-per-cell and the zero-cell count**, not from the `partial` share.
3. **Expect `compactCells` to yield almost nothing.** There are no uniform interiors to collapse.

The measurement above is a lower bound on cells and candidates, because the fallback added one cell per
sub-cell polygon rather than every cell its ring touches; a real builder's numbers will be higher. The
national figure was not extrapolated from one urban authority (§10).

**One reprojection the pilot needs, and it is not optional.** The service is EPSG:2157 and its bulk export
carries ITM metres under a `crs` member that RFC 7946 removed (§2.7 trap a). Use `outSR=4326` on the query
path or reproject explicitly, and **assert the result lands inside the Department's declared bounding
box** — a silent identity transform puts Ireland's zoning at latitude 735,435.

Two traps carry over from the sibling surveys, already commented in place in `coverage-region.ts` and
`build-poi.ts`: `polygonToCells` takes `[lat, lng]` per vertex in its default mode, and a coverage cell
must be `cellToParent` of the finer cell rather than a direct `latLngToCell` at the coarse resolution.

## 7. The outcome — one pilot, one recorded threshold finding

### 7.1 The pilot: Ireland, the Department of Housing, Local Government and Heritage GZT layer

Five reasons, in the order they bind.

1. **It is an authority's adopted designation, which is the only thing this layer is allowed to repeat.**
   A national department republishing 30 local authorities' adopted plans is the same object class the
   flood and erosion layers carry. Every US alternative is a research assembly, a commercial extraction,
   or a community observation.
2. **It answers the survey's hardest question by example.** The issue asked whether to carry local codes
   verbatim or to author a crosswalk. Ireland's Department did both and said in writing that the
   crosswalk "complements (rather than replaces)" the local vocabulary. A pilot that transcribes that is
   demonstrating the decision rather than asserting it.
3. **The acquisition path was exercised end to end.** 247,452,342 bytes of GeoJSON in 41.1 s, 85,330
   features, feature counts agreeing exactly between the bulk export and the service, coded-value domains
   readable, no key and no registration.
4. **It puts the meaning-of-zero rule under a new kind of pressure, which is the point.** The flood layer
   taught that absence inside a mapped country is a designation. Erosion inverted that. **Zoning inverts
   it harder**: absence is one of at least four different things (§3.2), the authority states "unzoned" as
   a positive value on 4 rows so the other absences are demonstrably not designations, and one authority's
   drafting convention moves the national zoned-area figure by 41 %.
5. **Its traps are the useful kind.** A ring-orientation convention that flips point-in-polygon answers
   inside 1,210 features, a `crs` member the format removed, a currency flag that does not mean current,
   and a documentation host with no DNS record — each is silent, each produces a well-formed wrong answer,
   and each has an exact check.

**One thing the pilot may not do.** It ships at **`tier: build-local`**, not `shipped`, until the licence
contradiction in §2.7 is resolved in writing. Three published statements disagree about the grant and one
of them names Tailte Éireann's rights as reserved. A `shipped` layer needs one grant it can quote, and
this record does not have one.

**The region** is the product's own extent — the Republic of Ireland, whole — because the Department
publishes it as one set and the layer's identity is that product. The verification ladder still runs on a
smaller area first.

**The verification ladder.**

**Fixtures.** Hand-built geometry, no network. A square zone, an adjacent one, **a zone with a hole
encoded by ring orientation**, a zone smaller than one cell, and two zones in different plans over the
same ground. It asserts: a wholly-interior cell resolves from the index without touching geometry; a
sub-cell polygon still receives at least one cell; **a point inside a hole returns no zone**; a point
outside every polygon produces **no coverage row and no negative claim**; the local code is stored
byte-identically including case and trailing space; an undeclared crosswalk code is recorded as observed
rather than coerced or dropped; and an `inferred` row never answers an `authoritative` question.

**Smoke.** One local authority from the real service — South Dublin, 5,478 features, already measured
here. This verifies what fixtures structurally cannot: the actual field names, that `outSR=4326` lands
where Ireland is, that the signed-ring sum matches the source's own `Shape__Area`, and the seal.

**Full.** All 85,330 features. Memory must stay flat in row count, and any coverage insert must be chunked
— `writeLayerCoverage` already batches at `COVERAGE_INSERT_BATCH`, and a hand-rolled insert re-earns
SQLite's 32,766 bound-variable ceiling.

**And two agreement checks against a second path**, because both catch a class of defect that is otherwise
silent:

1. **Area.** The sum of `signed_area_m2` over the built artifact against the service's own `Shape__Area`
   sum. Measured here: **5,444.5 km² both ways**, against 5,666.6 km² if rings are read as all-exterior.
2. **Points.** A sample of points re-asked of the live service. Its **negative half matters as much**: a
   sample of Donegal points and a sample of Northern Ireland points, confirming the artifact returns **no
   row** rather than a permissive reading.

### 7.2 The recorded finding — the threshold the United States does not meet, and by how much

The issue named this outcome as a completion, and it is the one the US half reaches.

**The threshold, recorded.** A zoning layer is worth building for a region when **a single verified
acquisition — one publisher, one redistribution grant, one schema — covers a stated population against a
named denominator, and the publisher states its own coverage.** The unit is one acquisition, because that
is the unit each of the three sibling surveys picked and the unit a builder issue carries; and the test is
a _grant_ rather than availability, because §2.3 found four separate sources that download without
friction and license nothing.

**Ireland meets it.** One publisher, 30 of 31 authorities, 96.76 % of the State's population against the
Census 2022 denominator, one schema, one download — with the grant itself still open, which is why §7.1
holds the tier at `build-local` rather than calling the threshold met outright.

**The United States does not meet it anywhere, and here is the arithmetic.** Denominator throughout:
**341,784,857**, the US resident population at 2025-07-01, Census Bureau `NST-EST2025-ALLDATA.csv`
(HTTP 200, 53,555 bytes, `Last-Modified: Tue, 27 Jan 2026`, read 2026-08-27). The same file's national row
is reproduced exactly by summing its 51 state rows, and it agrees with the Vintage 2025 county file's
3,144 county rows.

| what                                                                                                |      people |       share | acquisitions | grant?                                                                                     |
| --------------------------------------------------------------------------------------------------- | ----------: | ----------: | -----------: | ------------------------------------------------------------------------------------------ |
| **Zoning somebody has read and normalized** — National Zoning Atlas, 11,015 of 33,295 jurisdictions | 224,494,683 | **65.68 %** |            1 | **No — redistribution and commercial use prohibited**                                      |
| Every state publishing statewide zoning polygons under terms a layer could plausibly take           |  64,609,355 | **18.90 %** |           10 | **every one has an open question**                                                         |
| — California (568,741 polygons, 534 jurisdictions measured against a claimed 535 of 539)            |  39,355,309 |     11.51 % |            1 | `license_id` **null**; "No restrictions on public use" is not a grant                      |
| — Washington (470,130 zones, 320 jurisdictions)                                                     |   8,001,020 |      2.34 % |            1 | a commercial-use restriction under RCW 42.56.070(8)                                        |
| — Oregon (114,823 polygons, 245 jurisdictions)                                                      |   4,273,586 |      1.25 % |            1 | not established                                                                            |
| — Connecticut (2,297 districts, 169 of 169 towns)                                                   |   3,688,496 |      1.08 % |            1 | non-government, frozen at 2022-04-27, source repository **404**                            |
| — Utah (749 polygons, 69 of 261 municipalities)                                                     |   3,538,904 |      1.04 % |            1 | the publisher labels it `IN PROGRESS`                                                      |
| — Hawaii (906 state districts + 14,913 county zones)                                                |   1,432,820 |      0.42 % |            1 | not established                                                                            |
| — New Hampshire, Rhode Island, Montana, Vermont                                                     |   4,319,220 |      1.26 % |            4 | empty `licenseInfo` or a disclaimer; two MIT chapters (see below)                          |
| **What a redistributable layer can stand behind today** — the two MIT-licensed chapters             |   2,577,514 |  **0.75 %** |            2 | Montana and Hawaii on GitHub — **and the rights chain back to Land Use Atlas is unstated** |

**The gap between 65.68 % and 0.75 % is the finding, and the gap is licensing rather than coverage.** The
reading has been done — 1,337,510 pages of it — and effectively none of it can be carried. The layer's
problem in the United States is not that the patchwork is unmapped; it is that publishers do not say
whether it may be copied. **§2.6 measures that directly: 1,700 of 2,000 enumerated public zoning services
(85.0 %) carry an empty `licenseInfo`, verified against a false-negative check of 25 of 25.**

**Why the unit is an acquisition and not a percentage.** The 2022 Census of Governments counts **90,837
local governments**, of which **38,736 are general purpose** — 3,031 counties, 19,491 municipalities and
16,214 townships — and **the Census never asks whether a government zones**: the string `zoning` appears
zero times in the table's documentation. The best-sourced statement of the universe is the National Zoning
Atlas team writing in HUD's peer-reviewed _Cityscape_, verbatim: "Of 38,779 general-purpose governments as
of 2017… **tens of thousands of local jurisdictions have likely enacted zoning.**" A per-jurisdiction
program at even half an hour each is on the order of sixteen thousand hours, before any plan is amended.
So the number that decides whether this layer is buildable is not the population share; it is **how many
acquisitions that share costs**. Ireland is one. California would be one. The remainder of the United
States is tens of thousands.

**What would change this finding**, stated so the negative is falsifiable rather than final:

1. **California states a grant.** Its statewide layer is one clarification away from taking the US figure
   from 0.76 % to 12.35 % in a single acquisition, and it is the highest-value question on this list.
2. **Berkeley's Othering & Belonging Institute resolves its own contradiction** between an MIT
   `LICENSE.txt` and a noncommercial README. Its `CAZoning` repository is real statewide California
   polygon data and its README invites the email.
3. **Land Use Atlas's licensing arm offers redistribution terms.** It exists as of spring 2026 and sells
   bulk files; whether any tier permits redistribution was not established (§10). This is the single
   change that would move 66 % at once.
4. **A state mandates a standard statewide zoning layer.** None does today: New Jersey's statewide
   "Municipal Zoning" layer is, in its own words, "links to online municipal zoning maps, zoning
   ordinances and zoning office contact information", and the Department of Community Affairs "cannot
   confirm the currentness or accuracy of these documents."
5. **A different question.** If what a consumer wants is _observed_ land use rather than the legal
   designation, Overture's `base/land_use` already answers it, nationally, under ODbL — and that is a
   **different layer with a different name**, carrying §5's `inferred` grade. It must not be built under
   the word "zoning", because it does not state what is permitted and a reader would take it as if it did.

**And the European half of that finding is separate.** §2.8 established that INSPIRE obliges a binding
vocabulary and creates no retrievable European layer: the central index was retired on 2026-07-01, the
theme's registered population is largely a German per-plan metadata index, and the six member states
tested present six different service architectures under at least four licence families. **A European
zoning layer is a per-member-state acquisition program too** — which is why the pilot is one member state
rather than the theme.

## 8. The product requirement

A caller who geocodes an address in a jurisdiction whose planning authority publishes zoning receives,
alongside the ordinary result and without changing it, that authority's own zoning designation for the
resolved coordinate — **the authority's own code in the authority's own spelling**, its description, the
named plan it belongs to and that plan's stated validity window, the publishing authority, and, where and
only where the authority itself publishes one, its generic classification carried as a separate labelled
value that never replaces the local code. Where the authority publishes no determination, the caller
receives that fact and receives no permissive one: the coverage basis licenses presence only, so an absent
polygon is reported as "this product says nothing here" and never as "no restriction applies", because the
source does not distinguish land outside a plan from land inside a plan that the plan does not zone. Where
an observed land-use layer is also attached, its answer is reported as a separate, separately attributed
statement carrying the `inferred` grade, and the two are never combined into one claim — a measurement in
one jurisdiction found that only 33.8 % of community-mapped residential polygons sit on residentially
zoned land. The observation states what a plan assigns at a location and never what may be built there,
because the publishing authority declines that second statement in writing. Ranking, abstention and every
existing result field are unchanged; the observation is additive, attributed, and default off.

## 9. The builder-issue outline

Not filed here. The outline, for the issue that lands against this survey.

**Shape.** Following `bdc`: a workspace holds acquisition, parsing and the layer reader; the CLI is thin
wiring. `gazetteer build bdc` takes `--state` as a FIPS code, which is the precedent for a region-scoped
build; the zoning equivalent takes the publisher and an optional local-authority selector for the smoke
rung.

**Registration.** A new workspace joins several registers and only the first fails loudly — the root
`workspaces` array, the `.release-it.json` publish list (or a sanctioned-absence entry with the reason as
data), **both** root `tsconfig.json` reference entries, and the `smoke-clean-install.ts` pack set; the
full paragraph is in the root `AGENTS.md`. The arithmetic currently reads **59 workspaces, 53 in the
release list, six absent with a stated reason each** (measured 2026-08-27); re-run it afterwards and
confirm every absent name still has a reason someone can state.

**Acquisition.** The rule binds where it draws its line. The service metadata read, the coded-value domain
read and per-feature queries are API requests and go through `APIClient`; a 247 MB GeoJSON archive
streamed to disk is a file transfer and keeps raw `fetch`, saying so in place, as `osm/sdk/fetch.ts` and
`tiger/sdk/download.ts` do. Four behaviours to write into the client, each measured in §2.7: the Hub
download endpoint returns a job result whose `resultUrl` **302s**, so the fetch needs `-L`; the bulk
export is **EPSG:2157 under a `crs` member RFC 7946 removed**; **holes are encoded by ring orientation**
in both `f=geojson` and `f=json`; and `GZT_LINK` points at a host with no DNS record, so
`definition_url` cannot be populated from it.

**Build.** Ingest with `outSR=4326` or an explicit reprojection, and **assert the result lands inside the
publisher's declared bounding box**. **Resolve hole roles from signed ring area** — clockwise is exterior
under this service's convention — and **store `signed_area_m2`, comparing the total against the source's
own `Shape__Area` sum as a build-time check** (5,444.5 km² either way; 5,666.6 km² if you get it wrong).
Build `zoning_area` with precomputed bounding boxes and unsimplified rings as the truth. Index
**cell-touches-polygon**, and **fail the build if any feature ends with zero cells** (§6.4: at res 9 that
would be 86.8 % of them). Carry `local_code` verbatim and `crosswalk_code` beside it, never instead of it.
Record observed-but-undeclared vocabulary values rather than coercing them. **Write `layer_coverage` at
`basis = source_present`** and add a test that fails if any code path reads `supportsExclusion` as true
for this layer. Write the manifest at `tier: build-local`; seal 0444; build-then-swap.

**Measure and report** the candidates-per-cell distribution and the zero-cell count at res 9, 10 and 11
over the full national set, and pick from the measurement (§6.4 measured one authority; the national
figure is not extrapolated).

**Verify** on the fixtures → smoke → full ladder in §7.1, ending with both agreement checks and the
negative half of the second.

**Wire** the observation per §8, default off behind the presence of a layer path rather than a boolean —
the shape `poiSemanticLookup` settled — with its row in the
[runtime-flag register](../../engineering/reference/runtime-flags.mdx) in the same change, because SCOPE
invariant 5 makes a flag with no register row a smell. Pin the byte-stability of the ordinary result with
the layer absent.

**Settle in writing** before any `shipped` tier: the licence contradiction (§2.7), the mapped-footprint
question (§3.2), the spine-key declaration for a polygon-derived cell layer, and whether the advisory code
extends the query-intent vocabulary or widens the carrier. The last two are shared with all three sibling
surveys and should be answered once for all four.

**Do not** build an observed land-use layer in the same issue. It is a different provenance grade under a
share-alike licence, and §5 is the reason.

## 10. What could not be verified

Recorded as gaps rather than filled in. Nothing below was completed with a plausible reading.

**The pilot's open questions.**

- **The licence.** Three published statements disagree (§2.7), and `myplan.ie` names a fourth as
  authoritative — "For full details of conditions of use please see map viewer splash screen". **That
  splash text was not retrieved.** Two ArcGIS instant-app configurations linked from the viewer page were
  read (`5d9bad421ce242b280cd709d4c50afca`, `c2369024339240a7950115bfbb3d6dde`) and neither is the zoning
  viewer's. **This is the single fact that would move the pilot from `build-local` to `shipped`.**
- **The generic-type definitions.** All 85,330 rows link to `viewer.myplan.ie`, which has **no DNS record**;
  three candidate replacements on the live host return 404. The 54 code-to-label pairs survive in the
  service's coded-value domain; the **definitions** behind them do not, so `zoning_vocabulary.definition`
  cannot be populated for the pilot.
- **The publisher's own coverage statement.** The item description says "Awaiting data for some Local
  Authorities - please see map viewer for coverage details". Donegal's absence was recovered by measuring
  `LA_CODE`, not read from a statement. Whether other authorities are partially rather than wholly
  represented is unknown, and it is why `zoning_mapped_extent` stays empty.
- **The refresh cadence.** No maintenance-frequency statement was found. `UPLOAD_DATE` runs to 2026-06-18
  and the item's `modified` is 2026-05-13; neither is a commitment.
- **Ireland's national land area**, which would turn the measured 5,444.5 km² of zoned land into a
  percentage. The CSO PxStat `ReadCollection` endpoint returns **HTTP 500** and no area table was located
  through `ReadDataset`. The absolute figure is reported and no percentage is derived from it.
- **The 3.0 % area disagreement was resolved, and the leftover was not.** Reading rings as all-exterior
  gives 5,666.6 km² against the signed 5,444.5 km²; 149.3 km² of the 222.1 km² gap is the single Meath
  polygon and the rest is the other 1,209 hole-carrying features. Per-feature the export matches the
  service exactly (five features checked, identical vertex counts and areas), so the export is not
  simplified. Why the service encodes holes by orientation rather than nesting is an ESRI convention, not
  a documented choice of this publisher.

**United States.**

- **Whether Land Use Labs' commercial tiers permit redistribution.** Bulk files and API access exist as of
  spring 2026 under "additional or separate agreements"; no such agreement is public. **This is the change
  that would move 66 % of the US population at once**, and it is one question to a named organisation.
- **Whether the National Zoning Atlas's terms reach the Mercatus-hosted mirrors or the MIT-licensed
  GitHub repositories.** The state chapters were produced by separately funded regional teams; nobody
  states the rights chain either way. Needs written confirmation, not a reading.
- **The Berkeley Othering & Belonging Institute contradiction** between an MIT `LICENSE.txt` and a
  noncommercial README on the same repositories. Its README invites the email; it was not sent.
- **California's grant.** `license_id` is null, `licenseInfo` is empty, and the rights field says "No
  restrictions on public use" — which is a description, not a licence. Unresolved rather than permissive.
- **The Urban Institute's ODC-BY 1.0 statement** rests on a single Wayback read (`20251018071606`);
  `urban.org` and `datacatalog.urban.org` return **HTTP 403** to this network. Not corroborated by a
  second route.
- **The count of jurisdictions holding zoning authority.** The 2022 Census of Governments counts 90,837
  local governments and 38,736 general-purpose ones, and **its own documentation contains the string
  `zoning` zero times** — the survey classifies governments by type and function and never asks whether
  one zones. The National Zoning Atlas's 33,295 is that project's own identified universe, matches no
  Census total (it sits between 38,736 and 35,705), and is used as such throughout. **Nobody has counted
  this**, and a claim that anybody has should be checked before it is repeated.
- **The National Zoning Atlas's live coverage figures.** `api.zoningatlas.org/nza_coverage` returns
  **HTTP 403** to this network, plain and browser-headed. The 11,015 / 224,494,683 pair is read from the
  homepage markup, where it is the **fallback** value the page renders when the endpoint does not answer.
  Every use of those two numbers in this record carries that qualification.
- **A Census "Survey of Local Government Zoning".** Searched across the full API catalogue (1,798
  datasets), the Census of Governments landing page and its notes; **no trace**. Do not assert it exists.
- **Licences on several sampled sources**: Vermont's statewide layer (`licenseInfo` null, and the state's
  open-geodata policy scopes itself to a portal the layer is not in), Jefferson County AL (the whole host
  returns 403 under six header combinations), Delaware, Sedgwick, Bannock and Dawes counties (fields empty
  or portal pages script-rendered), and whether the National Zoning Atlas's terms reach Connecticut's
  separately-hosted 2022 GeoJSON, whose source repository returns 404.
- **"Counties zone unincorporated areas only" as a general rule.** Verified for Minnesota alone
  (Minn. Stat. § 394.32 subd. 3) and measured for Maricopa County. California § 65850 and Washington
  ch. 36.70 were retrieved and contain no such clause; several other state hosts were unreachable. It is
  reported as a measured pattern across four sampled counties, not as a rule.
- **`catalog.data.gov` from this lab.** The CKAN API returns **HTTP 404** and `/dataset?q=…` **301s to the
  catalogue home page, dropping the query**. The counts in §2.2 came from a path that answers; this lab
  cannot reproduce them by the obvious route.
- **Four hosts refused this network throughout**: `mercatus.org`, `urban.org`, `jchs.harvard.edu` and
  `costar.com`, all Cloudflare 403 rather than authentication. **These are not absences** and must not be
  read as any.

**European Union.**

- **The INSPIRE Geoportal's own historical Land Use theme count.** The portal was retired 2026-07-01 and
  301s to `data.europa.eu`. The Wayback CDX API timed out repeatedly; an availability-API snapshot
  (`20231002005556`) was retrieved at 67,103 bytes and is a single-page-application shell rendering 1,377
  characters, with the counts loaded by script and never captured.
- **Country attribution for 101,418 of the 267,072 `PlannedLandUse` datasets** — 38 % carry the keyword
  with no catalogue link in the triplestore, so the German share is a floor rather than a figure.
- **Poland's Rejestr Urbanistyczny endpoints.** Documentation claims WMS, WFS and CSW; every candidate path
  returns an identical 22,530-byte application shell. Worth re-checking after the stated 2026-11-30
  transition date.
- **Czech national plan geometry.** The catalogue that should answer it returns 1,982 records that are
  **Slovak** (100 of 100 sampled identifiers resolve to `data.gov.sk`), and `geoportal.gov.cz`'s CSW
  returns HTTP 500 on `GetRecords`.
- **Whether Ireland's GZT is registered under the INSPIRE Land Use theme.** Not checked; the layer was
  reached through a commercial catalogue rather than through INSPIRE.

**Measurement traps found while running this survey.** Seven, all of the shape this repository keeps
writing down — a confident number that is not counting what was asked — and each caught only by a second
path:

1. **ArcGIS Online's search `total` is capped at 10,000.** Five different zoning queries all returned
   exactly 10,000; a nonsense query returned 0, which is what proves the API works and the number is a
   ceiling.
2. **ArcGIS Hub's `totalCount` is not a match count.** The quoted phrase `"zoning districts"` returns
   **944,023** against the single word `zoning` at **500,893** — a phrase cannot outnumber its own word.
3. **`data.europa.eu`'s search API ignores its `facets` parameter.** A deliberate nonsense facet key
   returned the identical full-corpus count of 1,893,030 as a real one.
4. **A SPARQL exact-literal keyword match returned 0 for a keyword present on 267,072 datasets**, because
   the literals are language-tagged. The zero reads as a finding.
5. **`returnDistinctValues` normalizes and a `GROUP BY` does not.** The distinct-values endpoint answered
   **555** local zone codes; the group-by answered **560**; the difference is exactly the five strings
   that collide on case or a trailing space.
6. **Reading GeoJSON rings as all-exterior over-reports area by 4.1 % and inverts point-in-polygon inside
   1,210 features.** The signed sum matches the publisher's own figure to the tenth of a square kilometre;
   the absolute sum does not.
7. **`polygonToCells` returns nothing for 86.8 % of zoning polygons at res 9.** A polyfill-only index
   would drop them silently, and every dropped polygon reads downstream as an absence of zoning.
8. **HTTP 200 repeatedly meant failure.** Screven County's layers return 200 carrying
   `{"error":{"code":500}}`; Dawes County's returns 200 carrying "Service may be stopped"; the Census API
   returns 200 `text/html` titled "Missing Key"; Minnesota's CKAN API returns 200 with an application
   shell; and one county's own published item URL is misspelled, returning a 404 body inside a 200. **A
   harvester checking status codes alone records healthy endpoints and ingests nothing.**
9. **A statewide layer can score 100 % on jurisdictions and hold no zoning at all.** New Jersey's
   "Municipal Zoning" has one row per municipality and the rows are hyperlinks to PDFs.
10. **An owner name is not an organisation identifier.** Searching the catalogue for `owner:COHGIS`
    returns the City of Hyattsville, Maryland — a false lead that would produce a confident wrong answer
    about Houston.
