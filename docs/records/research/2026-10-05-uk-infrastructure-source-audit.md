# UK infrastructure source audit for building feasibility (#2286)

Research date: 2026-10-05. Every claim below was verified against the publisher's own pages or APIs on
that date unless marked [inferred]. The audit answers which public sources can support claims about
London/UK building entrances, ducts, poles, cabinets, exchanges and backhaul or connection points, and
it keeps asset presence apart from connectivity, capacity, rights and usability throughout.

## 1. The candidate sources

### OS OpenMap Local (Ordnance Survey)

- Publisher: Ordnance Survey. Download: `osdatahub.os.uk/downloads/open/OpenMapLocal`. Docs:
  `docs.os.uk/os-downloads/products/maps-and-imagery-portfolio/os-openmap-local`.
- Content: generalized building footprints at 1:10,000, roads, railways, functional sites. Entrance
  points and telecom assets are absent from this product. The licensed OS NGD Buildings theme added
  `Building Access Location` points on 2025-03-27 (access mode, purpose, obstruction, linked building
  id) — the only OS product found that records entrances.
- Coverage: Great Britain, with Northern Ireland out of scope. Per-feature geometry, cartographically
  generalized.
- Vintage: refreshed every six months (April, October). Records carry per-feature observation dates
  only in NGD (`versiondate`, `geometry_evidencedate`); OpenMap Local has none.
- Access: free download from the OS Data Hub.
- Permitted use: `Open Government Licence v3.0`. Attribution required; commercial use and derived
  redistribution permitted; copyleft absent.
- Authority: OS surveys geography. It owns no telecom plant and can assert presence, while connectivity
  remains operator data.

### Ofcom Connected Nations

- Publisher: Ofcom. Hub: `ofcom.org.uk/research-and-data/multi-sector-research/infrastructure-research`.
  Latest: Connected Nations update Spring 2026 (published 2026-05-13, fixed-broadband snapshot
  January 2026).
- Content: provider-reported service availability (SFBB, UFBB, full-fibre, gigabit, speed bands)
  against an OS AddressBase premises base, plus local-authority-level full-fibre take-up. Physical
  plant is absent: ducts, poles, cabinets and exchanges appear in zero published fields.
- Coverage: whole UK. Finest public granularity is the postcode (~1.73M rows), and even there records
  are counts and percentages of premises rather than per-premises rows. Full-fibre availability is
  suppressed at postcode and output-area level for commercial confidentiality. Per-UPRN records exist
  in Ofcom's collection and stay unpublished.
- Vintage: annual report plus two updates a year; each file carries a uniform snapshot date.
- Access: anonymous ZIP/CSV download, registration-free, and bulk has no API.
- Permitted use: `Open Government Licence`. Ofcom's site terms add accuracy and no-warranty conditions.
- Authority: Ofcom aggregates operator declarations under statutory powers. A coverage record is the
  strongest public orderability signal, and it remains a declaration rather than a measurement, silent
  on ducts, poles, capacity and wayleaves.

### UK Power Networks open data (and the other GB DNOs)

- Publisher: UK Power Networks (the DNO for London, the South East and the East of England). Portal:
  `ukpowernetworks.opendatasoft.com`, catalogue API at `/api/explore/v2.1/catalog/datasets`
  (138 datasets on 2026-10-05).
- Content: per-pole point datasets (LV 370,160 poles; HV 282,106; 33kV/132kV 7,313), grid and primary
  substation sites (1,504, with transformer ratings and demand), secondary substation sites (72,750,
  with utilisation band and address), underground cable route polylines (LV alone 2,015,774 records).
  The catalogue holds zero duct or chamber datasets and zero telecom datasets.
- Coverage: the three UKPN license areas, which include all of London. Per-asset points and polylines.
- Vintage: per-dataset modified dates (poles 2026-09-22, secondary sites 2026-06-15, LV cables
  2026-03-30) with no stated cadence. Some site records carry commissioning and assessment dates; pole
  records carry none.
- Access: anonymous catalogue; free registration to download records. Official Python client `ukpyn`.
- Permitted use: `CC BY 4.0` for poles and sites. Underground cable routes sit under the bespoke
  `UK Power Networks Shared Data Licence — Connections`, whose text is behind a SharePoint link this
  audit could not retrieve; treat cable-route reuse as license-restricted until that text is read.
- Authority: UKPN owns and operates the assets, so records are authoritative for the presence of power
  plant. Attachment rights, duct space and telecom usability sit outside every dataset.
- The other GB DNOs publish less: Northern Powergrid, NGED, SSEN, SP Energy Networks and Electricity
  North West list substations and capacity and publish zero per-pole datasets [inferred from portal
  searches]. UKPN appears to be the only GB DNO publishing per-pole points.

### NUAR (National Underground Asset Register)

- Publisher: GDS Geospatial (DSIT); Ordnance Survey has operated it since 2025. Guidance:
  `gov.uk/guidance/national-underground-asset-register-nuar`; portal `nuar.uk`.
- Status: operational since December 2025 (public beta June 2025), on a statutory footing via the Data
  (Use and Access) Act 2025. Over 400 asset owners, 3.2M km of underground assets, about 80% of known
  buried plant (OS, 2026-09-15). Telecom ducts and buried cables are in scope, including a significant
  proportion of Openreach's network.
- Coverage: England, Wales, Northern Ireland. Scotland runs the separate VAULT system. Per-asset
  geometry at safe-dig detail. Underground only — poles, cabinets, exchanges and entrances are outside
  the remit.
- Vintage: live platform; owners must keep data current. Whether records carry per-asset observation
  dates: unresolved from public material.
- Access: invitation-only for asset owners and their authorised contractors under Data Distribution
  Agreements. Anonymous download, public API and bulk export are all absent. A sandbox for expanded
  access (public-sector bodies, emergency services) went live in August 2026; wider access is
  undecided and needs secondary legislation.
- Permitted use: this is the decisive constraint — the end-user terms restrict NUAR to strike avoidance
  and statutory safe-digging duties and **explicitly prohibit "business case development… determining
  best location(s) for network expansion (e.g. heat, broadband, etc.)"**. Even with access, NUAR cannot
  lawfully feed a telecom feasibility product today. Monitor the access-expansion consultation; plans
  should exclude NUAR.
- Authority: owner-supplied records aggregated by OS. Presence of buried plant only — capacity, spare
  duct space and orderability are outside the data model.

### Planning records (planning.data.gov.uk, Planning London Datahub, borough portals)

- Publishers: MHCLG (`planning.data.gov.uk`), the GLA (Planning London Datahub,
  `apps.london.gov.uk/planning/`), and each borough (example: Camden's Socrata portal).
- Content: the development pipeline — application number, address, description, registered and decision
  dates, applicant name; the GLA's extra questions add residential unit counts, floorspace,
  commencement and completion dates. Camden locates applications to the nearest postcode (OS Code-Point
  Open), degrading site geometry. Infrastructure assets are outside every dataset here.
- Coverage: planning.data.gov.uk's planning-application dataset is national in ambition and incomplete
  in practice (100,627 records; the page warns it "is incomplete and is not yet ready for use"). The
  PLD covers every London planning authority with records back to 2004 for residential gains above one
  unit.
- Vintage: PLD updates daily and tracks applications from validation through completion. Records carry
  per-stage dates. planning.data.gov.uk's collector last ran 2025-09-17.
- Access: anonymous bulk download and public APIs; registration-free and free of charge.
- Permitted use: `OGL v3.0` for planning.data.gov.uk and the PLD. Camden's dataset-level license reads
  ambiguous (`Licence: None` on the harvested data.gov.uk record) — confirm before redistributing.
- Role in the audit: a leading indicator of future demand (new units, major schemes) and a source of
  dated construction windows. Asset claims are absent by design.

### OpenStreetMap (telecom and power street furniture)

- Publisher: the OSM contributor community. Docs: OSM Wiki, WikiProject Telecoms. Bulk: planet and
  Geofabrik extracts; query: Overpass API.
- Schema expressiveness: cabinets (`man_made=street_cabinet` + `utility=telecom`, optional `operator`,
  `ref`), exchanges (`telecom=exchange` with `telecom:medium`, `operator`, `ref`), connection and
  distribution points (`telecom=connection_point`, `telecom=distribution_point`), poles (`power=pole`;
  `man_made=utility_pole` + `utility=telecom`), overhead lines (`communication=line` — one of four
  rival tags; the wiki itself calls cable tagging unstandardized). Underground cables and ducts are
  "rarely mapped"; `man_made=duct` has zero GB uses.
- GB coverage (taginfo on the Geofabrik extract, 2026-10-05): `power=pole` 1,664,657 [inferred to
  include a bulk import — the count is anomalous for crowdsourced survey]; `man_made=street_cabinet`
  18,564; `telecom=exchange` 2,907 against Openreach's ~5,600 real exchanges [inferred gap];
  `telecom=connection_point` 120; `telecom=distribution_point` 15. London-bbox Overpass counts remain
  unproduced: overpass-api.de returned HTTP 406 from this host and the mirrors were busy.
- Vintage: continuous editing. Every element carries a last-modified timestamp — an edit date rather
  than a survey date.
- Access: anonymous and free.
- Permitted use: `ODbL 1.0`. Attribution plus share-alike: a publicly used adapted database that merges
  OSM-derived cabinet or pole layers with operator data must itself be offered under ODbL. Produced
  works (rendered maps) are exempt from share-alike. This is the repo's standing build-local boundary
  and this audit leaves it unchanged.
- Authority: crowdsourced observation. Presence only, with unknown completeness — an empty OSM cell is
  `source_present` evidence and supports zero exclusions.

### Operator public data (Openreach, CityFibre, Community Fibre, Virgin Media)

- All four own and operate their networks, so their checkers are first-party authority for
  orderability on their own plant — and all four expose per-address interactive checkers alone. Bulk
  download and public per-premises APIs are absent across all four.
- Openreach: UK-wide checker plus an exchange-level build-programme PDF (March 2026). Its site terms
  prohibit "macros and robots that input volume transactions" and republication. PIA (physical
  infrastructure access) product data reaches communications providers under the PIA agreements and
  stays non-public.
- CityFibre: per-address checker; the operator refuses coverage and timing inquiries by policy. Its
  plant portal (`plant.cityfibre.com`) issues per-area asset PDFs under login from its asset team — the
  one operator channel that exposes physical plant, and it is credentialed and per-area [asset classes
  in the PDFs unconfirmed].
- Virgin Media and Community Fibre: per-address or per-postcode retail checkers under standard
  proprietary site terms. Virgin Media's availability statement reads "subject to survey, network
  capacity and credit check" — even a positive check leaves orderability conditional.
- Vintage: release dates and cadence are unpublished by every operator [inferred: none found].
  Openreach checker results carry states (`orderable`, `in plan`, `not in plan`) without per-record dates.

## 2. The required relations, mapped to sources

| Relation                        | Best public source                                                                                                    | Limit                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| owns (network plant)            | Operator records; UKPN for power assets it owns                                                                       | Public telecom ownership layers are absent.                              |
| owns (the building)             | HM Land Registry (paid; outside this audit); PLUTO-style municipal data exists only in the US                         | UK fee ownership is closed data.                                         |
| connects-to (physical topology) | NUAR internally for buried plant; operator GIS                                                                        | Public topology sources are absent; proximity implies presence at best.  |
| supplies (service availability) | Ofcom Connected Nations at postcode level; operator checkers per address                                              | Per-UPRN data is collected and stays unpublished; checkers bar bulk use. |
| may-attach (poles, ducts)       | Openreach PIA, CP-only; CityFibre plant portal, credentialed                                                          | Public attachment sources are absent.                                    |
| capacity                        | UKPN substation ratings and utilisation (electrical only)                                                             | Telecom capacity data is unpublished.                                    |
| condition                       | UKPN per-site assessment dates (partial)                                                                              | Public telecom condition data is absent.                                 |
| access (wayleave, consent)      | Operator and landlord records only                                                                                    | Always private.                                                          |
| observation date                | PLD per-stage dates; Ofcom snapshot dates; UKPN dataset modified dates; OSM edit timestamps (edit rather than survey) | Most asset records carry zero survey dates.                              |

## 3. Existing extraction, audited before any new work (DoD item 3)

- #1375's OSM telecom extractor is `packages/osm/sdk/extract/poi.ts` (`extractOSMPOIs`, ogr2ogr over
  Geofabrik PBF): four categories — `telecom_exchange`, `telecom_cabinet`, `tower_comms`,
  `data_center` — registered in `packages/poi-taxonomy/data/curated-overlay.json` as
  `mailwoman-infra`, build-local. The `--source osm` build branch is
  `packages/mailwoman/tools/gazetteer-pipeline/poi/build/poi.ts`. Fixture-proven plus two real-PBF
  receipts (DC 18 rows, Vermont 103 rows, 2026-08-11, Overpass cross-checked); Vermont's bbox coverage
  included territory outside the extract polygon, the known limitation this issue names. All of it is
  reusable as-is; a London extract would reuse this branch.
- The layer contract (`docs/engineering/reference/layer-interface.mdx`) already encodes the evidence
  semantics this issue asks to demonstrate: `layer_coverage` rows carry `basis`
  (`designated`/`surveyed`/`source_present`) and `observed_rows`, and a missing row means unknown
  rather than zero.
- Existing layers and their bases: flood (`packages/flood`, EA Flood Map for Planning, England,
  `designated` — the one layer that can establish absence, including for London sites), soil (US only),
  coastal erosion (EA NCERM England, `source_present`), zoning (Ireland). The GB unit register
  (`nsul.db`, build-local) maps UPRN to unit postcodes — the per-premises denominator a UK dossier
  needs. GB gazetteer data held: `gb-regions-v1.jsonl` (12,445 rows), `london-pairs-v2.jsonl` (966),
  `postalcode-gb-codepoint.db` (`OGL v3.0`).
- The dossier's `LayerReading` (`packages/dossier/lib/coverage.ts`) has zero producers yet; every
  layer's coverage rows already store what a producer needs (per-cell `observed_rows` and `basis`). The
  missing piece is an adapter from layer readers to `LayerReading`, rather than new data.
- The BDC machinery itself is already built and exercised: `@mailwoman/bdc` holds the credentialed
  public-API client (`packages/bdc/sdk/client.ts` — throttle, disk cache, retry, explained credential
  failures), vintage discovery (`sdk/filing/dates.ts`), the listing and download path
  (`sdk/list-files.ts`, `sdk/download.ts`, with the extracted-CSV disk cache), the `bdc.db` layer
  builder (`sdk/build-bdc.ts`, writing `source_present` coverage cells at H3 — the `LayerReading`
  feedstock), and the plausibility layer (`lib/plausibility.ts`), which already abstains
  `insufficient_survey_data` when a cell was never surveyed — the missing-vs-empty distinction,
  running in production code. The data root holds a prior real download (Texas FTTP, D25 vintage). One
  defect found on this pass: the listing endpoint's subcategory vocabulary had drifted from the live
  API (#2465).

## 4. Missing versus surveyed-empty versus conflicting, demonstrated (DoD item 4)

The dossier package's four classes now each have a real or executable demonstration:

- **Missing (unknown)**: NUAR. A survey of underground telecom plant from public data is impossible,
  and NUAR's terms bar feasibility use even for participants. A dossier reading records basis `null`,
  records `null` → class `unknown`.
- **Source-present empty**: One Park Point, census block 360470504012000, FCC BDC fiber-to-the-premises
  as of 2022-06-30. Providers filed 70 FTTP rows in the surrounding tract and zero in the building's
  block. The report words it as "the source looked and found no record; absence is unknown" — and the
  2025-12-31 vintage proves the point: Verizon, Lightpath and Spectrum FTTP then appear at the block
  (6 rows). The 2022 zero was a filing gap during construction rather than a true absence.
- **Surveyed empty**: the EA flood layer's `designated` basis is the one current source that can
  establish absence (a Zone 1 reading is a defined complement). Synthetic coverage in
  `packages/dossier/lib/coverage.test.ts` pins the class.
- **Conflicting**: pinned synthetically in the same test. Real BDC data exposed a modeling bug on this
  pass: two vintages of one layer and extent (0 rows as of 2022-06-30; 6 rows as of 2025-12-31) grouped
  as "conflicting" until `buildDossier` learned that a vintage is part of a survey's identity
  (`packages/dossier/lib/dossier.ts`). Two vintages are two surveys.

## 5. The One Park Point retrieval receipt (the dossier's first real records)

The plan's after-plan item asked #2286 for independently retrieved, three-dated records for One Park
Point (11 Ocean Parkway, Brooklyn; BBL 3053220010, BIN 3429422). Retrieved 2026-10-05:

- NYC DOB NOW: Build (Socrata `w9ak-ipjd`): new-building filing B00520132-I1 — filed 2021-09-16,
  approved 2022-11-11, first permit 2022-11-15; 13 stories, 145 ft, 375 dwelling units, 395,643 sq ft,
  $20M initial cost; owner entity JEMB Realty; applicant of record FXCollaborative Architects. The DOB
  NOW Public Portal has published NB filings from the filing date since 2021-03-01 (nyc.gov guidance;
  the portal's operation is documented by PincusCo, 2021-09-03), so a filing's `availableAt` is its
  filing date.
- NYC DOB legacy filings (Socrata `ic3t-wcy2`): builders pavement plan filings 3314476/3314484, with
  the dataset's own `dobrundate` (2022-05-03) as `availableAt`.
- NYC DCP PLUTO 26v2 (Socrata `64uk-42ks`, rowsUpdatedAt 2026-08-24): 375 residential units, 379 total,
  13 floors, year built 2022, owner of record International Baptist Church (the ground lessor).
- NYC Planning Geosearch (PAD 26c): address ↔ BIN ↔ BBL identity link (live service; `availableAt` is
  the retrieval date).
- FCC BDC Public Data API (credentialed, `bdc.fcc.gov/api/public/map`): the NY location-coverage files
  for cable and FTTP at the 2022-06-30 vintage and FTTP at 2025-12-31. The anonymous map endpoints
  refused (HTTP 403); the credentialed API worked on the first attempt. Vintage publication dates: the
  2022-06-30 vintage first shipped with the National Broadband Map launch on 2022-11-18; the 2025-12-31
  file is stamped 2026-09-29.

These records are `packages/dossier/test/fixtures/one-park-point.ts`, and `dossier.test.ts` renders
three dossiers: as of 2022-06-30 (pre-permit: 375 planned units, developer and architect named with
signing authority unknown, provider evidence absent — the first BDC vintage was published five months
later), as of 2023-06-30 (Charter cable at the block, Verizon FTTP absent from the block and present
in the tract), and as of 2026-10-05 (PLUTO's completed 375, alias resolved through PAD, Verizon FTTP
2300/2300 at the block). 65 dossier tests pass.

The stated limit, carried from the spec and reinforced by `@mailwoman/bdc`'s documented boundary
(`packages/bdc/README.md`): the BDC Fabric — the `location_id` → rooftop/parcel map — is
CostQuest-licensed. This repository never ingests, ships or derives data from the Fabric; the
`location_id` values in the BDC rows (1146206901, 1146206903, 1554029131, and neighbors) travel as
opaque join keys that a Fabric-licensed user may join against their own copy. Census-block granularity
is therefore the designed boundary for this repository, rather than a stopgap awaiting a join.

The retrieval itself ran twice: once through the raw API during prospecting, and again through the
package's own machinery (`createBDCClient`, `retrieveAvailabilityFiles`, `downloadBDCFile`), which
reproduced every count exactly (tract 70 / block 0 FTTP at 2022-06-30, tract 128 / block 2 cable at
2022-06-30, tract 236 / block 6 FTTP at 2025-12-31). That pass caught one real defect: the SDK's
subcategory vocabulary for the listing endpoint had drifted from the live API (technology names as
State subcategories retrieve zero files; the live values are `Provider List`, `Location Coverage` and
`Hexagon Coverage`). Filed as #2465.

## 6. Prioritized UK source matrix (DoD item 5)

| Priority | Source                                                  | Feeds                                                         | Basis it can carry                     | Cadence       | License                                     |
| -------- | ------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------- | ------------- | ------------------------------------------- |
| 1        | Ofcom Connected Nations                                 | service availability per postcode                             | source_present (operator declarations) | 3 releases/yr | OGL                                         |
| 2        | Planning London Datahub                                 | demand pipeline, construction windows, unit counts            | observed per record, dated per stage   | daily         | OGL                                         |
| 3        | OS OpenMap Local (+ OS NGD access points when licensed) | building footprints, entrances                                | surveyed                               | 6-monthly     | OGL / licensed                              |
| 4        | UKPN open data                                          | power poles, substations, cable routes (co-location evidence) | designated by the owner for presence   | irregular     | CC BY 4.0 (poles/sites); bespoke for cables |
| 5        | OSM telecom extract (#1375 branch)                      | cabinets, exchanges, connection points                        | source_present, completeness unknown   | continuous    | ODbL (build-local)                          |
| —        | NUAR                                                    | buried ducts and cables                                       | owner-supplied                         | live          | barred for feasibility use                  |
| —        | Operator checkers                                       | per-address orderability                                      | first-party                            | live          | per-address only, bulk barred               |

## 7. The operator-data request (what public evidence leaves open)

For the pilot operator (a London FTTP overbuilder), public sources answer "is demand here, is a
building real, what does regulation declare available." The operator's own records must answer:

1. **Duct and chamber occupancy or spare capacity** — NUAR holds it and bars the use; operators publish
   zero occupancy data. Request: per-segment duct utilization or a yes/no spare-duct flag for named
   segments.
2. **Pole attachment feasibility** — pole locations (UKPN) exist; attachment rights and pole-top space
   stay private. Request: PIA-equivalent attachment status or a named contact for mixed pole routes.
3. **Per-premises orderability in bulk** — Ofcom suppresses full-fibre at postcode level and operator
   checkers bar bulk queries. Request: the operator's own premises-passed extract for the pilot
   geography, or its serviceability API under a rate limit rather than a ToS wall.
4. **Wayleave and landlord consent status** — private by definition. Request: the operator's wayleave
   register fields for sampled buildings (status class only, rather than terms).
5. **Build cost** — public unit-cost sources for MDU infill are absent. Request: anonymized cost bands
   from completed infill jobs, keyed by construction constraint class (flood zone, pavement type, duct
   length), so the cost model trains on the operator's own distribution.

Each request states the join key the dossier already produces: UPRN or building identity, plus the
evidence trail the answer would resolve.

## Source register

- OS Data Hub OpenMap Local and OS NGD Buildings docs (osdatahub.os.uk, docs.os.uk) — 2026-10-05
- Ofcom Connected Nations hub, Spring 2026 update, "About this data" (ofcom.org.uk) — 2026-10-05
- UKPN open data portal and catalogue API (ukpowernetworks.opendatasoft.com) — 2026-10-05
- NUAR guidance and FAQ (gov.uk, nuar.uk); OS news 2026-09-15 — 2026-10-05
- planning.data.gov.uk dataset pages; Planning London Datahub (apps.london.gov.uk/planning); Camden
  Socrata portal — 2026-10-05
- OSM Wiki (WikiProject Telecoms, tag pages), taginfo GB counts — 2026-10-05
- Openreach where-and-when and fibre-availability pages and site T&Cs; CityFibre help, ToS and plant
  portal; Virgin Media postcode checker; Community Fibre in-my-area — 2026-10-05
- NYC DOB NOW Build job application filings (w9ak-ipjd), DOB job application filings (ic3t-wcy2), PLUTO
  (64uk-42ks), Planning Geosearch, all via Socrata/NYC Planning — 2026-10-05
- FCC BDC Public Data API specification (fcc.gov, 2025-04-28) and the three downloaded NY coverage
  files — 2026-10-05
