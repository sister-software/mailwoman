# Three London buildings: identity and competition sources (#2467)

Research date: 2026-10-05. Each claim below was read from the named source on that date unless marked
[inferred]. This record selects three London residential buildings from open planning data, records
their identity sources, and lists every broadband competition source for each one with its status. The
[UK source audit](2026-10-05-uk-infrastructure-source-audit.md) describes each source in full.

#2467 separates three kinds of result. An address observation is a stated result for one address or
UPRN on a recorded date. Area context describes a postcode or a larger area, with its premises
denominator, snapshot date and resolution. Unknown covers a source that was unavailable, withheld a
provider name, lacked the address or gave no result. This pass holds area context and unattempted
sources. It holds zero address observations, because it submitted no address to a consumer checker and
holds no API key or license.

## 1. Sources of planning records

Each source below states an open license except the Planning London Datahub (PLD). The PLD states
none, so this record quotes none of its records.

| Source                                      | Publisher and file                                                                  | License                      | Role here                                                                                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| London Development Database (LDD)           | GLA, London Datastore `2jxq0`, `LDD Permissions for Datastore final.xlsx`           | `Open Government Licence v3` | Rows screened: address, postcode, grid reference, unit count, permission, start and completion dates                                                                                         |
| Referred planning applications since 2011   | GLA, London Datastore `2w1xz`, `Referable planning application data 2011-2024.xlsx` | `Open Government Licence v3` | Stage 1 and Stage 2 dates and unit totals for two of the three buildings                                                                                                                     |
| planning.data.gov.uk `planning-application` | MHCLG                                                                               | `OGL v3.0`                   | Screened without a candidate: Camden is its only London authority, its records carry no unit count or completion date, and neither Camden LDD row that reached step 9 describes one building |
| PLD                                         | GLA                                                                                 | none stated                  | Unused                                                                                                                                                                                       |

## 2. The screen

The screen read every row of the LDD extract (generated 2020-07-02). Steps 1 to 6 test the LDD's own
fields. Steps 7 and 8 test the row's postcode against ONS's postcode directory and Ofcom's postcode
files. Step 9 reads each surviving row's `Development Description`.

| Step | Criterion                                                                                                                                                                                                                | Rows   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| —    | LDD data rows                                                                                                                                                                                                            | 94,948 |
| 1    | `Current permission status` is `Completed`                                                                                                                                                                               | 58,606 |
| 2    | `Date construction completed` on or after 2017-04-01                                                                                                                                                                     | 10,883 |
| 3    | `Proposed Total Residential Units` at least 100                                                                                                                                                                          | 200    |
| 4    | `Permission Type` is `Full` or `Prior Approval (Class O - formerly J)`                                                                                                                                                   | 127    |
| 5    | `Post Code` is a full unit postcode                                                                                                                                                                                      | 92     |
| 6    | `Site Name/Number` and `Primary Street Name` present, and the site field contains none of the words land, site, plot, phase, former, estate, parcel, zone, development, blocks, area, adjacent, rear, bounded or between | 71     |
| 7    | `Post Code` live in the ONS Postcode Directory, February 2026                                                                                                                                                            | 40     |
| 8    | `Post Code` has a row in Ofcom's January 2026 all-premises postcode files                                                                                                                                                | 38     |
| 9    | `Development Description` describes the erection of one building or the change of use of one existing building                                                                                                           | 11     |

Step 9 excluded 27 rows. Nineteen describe two or more buildings, blocks or houses (16/1404, 2012/4628/P,
PP/2015/3558, P/3118/11, 2013/1978, 15/03343/FUL, 2015/5308, 14-AP-1872, P2014/0609/FUL, 2013/0685/P,
00707/396-418/P2, 14-AP-2948, HGY/2013/2379, PP/12/05112, 2011/0898, 14/089953, H/05856/13, 2013/0554 and
PA/14/02585). Seven state no building count (00870/F/P6, 11/03865/FULL1, 2483/10, 08/01599, 2013/2019,
00176/A/P62 and 120454). One, 14/01006/FULMAJ, varies a condition of an earlier permission.

The 11 rows that describe one building:

| Completed  | Authority        | Borough reference | Units | Address as recorded in the LDD         | Permission type |
| ---------- | ---------------- | ----------------- | ----- | -------------------------------------- | --------------- |
| 2020-02-24 | Croydon          | 17/02680/FUL      | 153   | 28-30 Addiscombe Grove, CR0 5LP        | Full            |
| 2019-09-04 | Barnet           | 16/0601/FUL       | 122   | 112-132 Cricklewood Lane, NW2 2DP      | Full            |
| 2019-08-19 | Croydon          | 14/02928/GPDO     | 120   | Carolyn House, Dingwall Road, CR0 9XF  | Prior Approval  |
| 2018-05-31 | Islington        | P2014/1017/FUL    | 119   | 130-154, 154a Pentonville Road, N1 9JE | Full            |
| 2018-05-04 | Hounslow         | 00676/3/PA4       | 171   | Central House 3, Lampton Road, TW3 1HY | Prior Approval  |
| 2018-03-29 | Islington        | P2017/2795/PRA    | 150   | Hill House, 17 Highgate Hill, N19 5NA  | Prior Approval  |
| 2018-03-06 | Wandsworth       | 2014/6909         | 135   | 12-14 Lombard Road, SW11 3RF           | Full            |
| 2017-07-01 | London Legacy DC | 06/90011/FUMODA   | 202   | 80 - 92 High Street, E15 2NE           | Full            |
| 2017-05-30 | Lambeth          | 09/04322/FUL      | 239   | 143 - 161 Wandsworth Road, SW8 2LY     | Full            |
| 2017-05-14 | Hackney          | 2012/3558         | 121   | 67a - 71 Dalston Lane, E8 2NG          | Full            |
| 2017-04-01 | Lambeth          | 14/01020/FUL      | 104   | 2 Barrington Road, SW9 7EB             | Full            |

Selection rule: the three most recently completed rows, one per planning authority. The rule takes
Croydon's 2020 row and passes over Croydon's 2019 row. The three buildings are in Croydon, Barnet and
Islington. No broadband source entered the selection, so no coverage value influenced it.

## 3. The three buildings

Each building's address is the planning site address as the LDD records it. The completed dwellings'
postal addresses (flat numbers, building names) sit in Royal Mail's PAF and OS AddressBase. Both
products are licensed, and this record leaves those addresses unknown. The postcodes that NSUL assigns
to the dwellings are inferred as follows. A postcode qualifies when ONSPD dates its introduction after
the permission date and NSUL places its UPRNs within 50 m of the LDD grid reference [inferred:
proximity and introduction date, rather than a published link between a planning record and a
postcode].

### A. 28-30 Addiscombe Grove, CR0 5LP (London Borough of Croydon)

- LDD: borough reference 17/02680/FUL, full permission decided by the borough on 2018-02-20, started
  2018-02-20, completed 2020-02-24, 153 proposed residential units, ward Fairfield, grid reference
  533018, 165662. The description proposes "a part 9, 20 and 21 storey building comprising 153
  residential dwellings (Class C3)".
- GLA referral: case 3831a, Stage 1 on 2017-07-19, Stage 2 on 2018-02-12, 153 total units, decision
  "Recommendation to allow LPA to approve".
- Postcodes [inferred]: CR0 5BX (75 UPRNs) and CR0 5BY (81 UPRNs), both introduced 2021-09, with every
  UPRN within 50 m of the grid reference. Together they hold 156 UPRNs against 153 consented units. The
  LDD postcode CR0 5LP (introduced 1980-01, live) holds 11 UPRNs, 2 of them within 50 m. All three
  postcodes sit in output area E00005233.

### B. 112-132 Cricklewood Lane, NW2 2DP (London Borough of Barnet)

- LDD: borough reference 16/0601/FUL, full permission decided by the borough on 2016-08-30, started
  2017-08-31, completed 2019-09-04, 122 proposed residential units, ward Childs Hill, grid reference
  524237, 186057. The description proposes "a part 3, part 6, part 8 storey building comprising 122
  no. residential units and 279 sqm (GIA) of commercial floorspace".
- GLA referral: the referral file holds no row for 16/0601/FUL.
- Postcodes [inferred]: NW2 2DL (78 UPRNs, introduced 2018-08) and NW2 2DW (40 UPRNs, introduced
  2019-09), with every UPRN within 50 m of the grid reference. Together they hold 118 UPRNs against 122
  consented units, and the other four units are unplaced. The LDD postcode NW2 2DP (introduced 1980-01,
  live) holds 38 UPRNs, 37 of them within 50 m. All three postcodes sit in output area E00178816.

### C. 130-154 and 154a Pentonville Road, N1 9JE (London Borough of Islington)

- LDD: borough reference P2014/1017/FUL, full permission decided by the borough on 2014-12-12, started
  2016-03-14, completed 2018-05-31, 119 proposed residential units on a site with 1 existing unit,
  ward Barnsbury, grid reference 530963, 183109. The site also takes in 3-5 and 5a Cynthia Street and
  2 Rodney Street. The description proposes "118 residential units (C3 use class)" in one building:
  "The building would consist of the following storey heights", with frontages on Rodney Street,
  Pentonville Road and Cynthia Street.
- GLA referral: case 2924b, Stage 1 on 2014-06-17, Stage 2 on 2014-12-02, 118 total units, decision
  "Recommendation to allow LPA to approve".
- Postcodes [inferred]: N1 9FS (37 UPRNs, introduced 2018-06), N1 9FW (6 UPRNs, 2018-06, 4 within
  50 m), N1 9FT (29 UPRNs, 2018-10) and N1 9FU (33 UPRNs, 2018-10), all in output area E00174805. The
  LDD postcode N1 9JE (8 UPRNs, introduced 2017-02) sits in output area E00174843. The five postcodes
  hold 113 UPRNs against 118 consented units. N1 9FH also has 31 UPRNs within 50 m and was introduced
  in 2009-07, before the permission, so it is excluded.

### Dates of the identity sources

| Source record                                                        | `observedAt`                | `availableAt` | `retrievedAt` | How each date was established                                                                                                                                            |
| -------------------------------------------------------------------- | --------------------------- | ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LDD row (A, B, C)                                                    | completion date of each row | 2021-01-13    | 2026-10-05    | The extract states it was generated 2020-07-02, and its Datastore entry was last updated 2021-01-13. The first publication date is unknown, so the later date bounds it. |
| GLA referral row (A, C)                                              | Stage 2 date of each row    | 2026-01-21    | 2026-10-05    | The Datastore entry states the file was updated on 21 January 2026 to include data up to 31 December 2024.                                                               |
| ONS Postcode Directory, February 2026                                | 2026-02                     | 2026-02-27    | 2026-07-22    | The ONS portal item for the CSV collection was created 2026-02-27. The host copy sits in a directory dated 2026-07-22.                                                   |
| National Statistics UPRN Lookup, June 2026 (Epoch 127)               | 2026-06                     | 2026-07-31    | 2026-09-03    | The ONS portal item was created 2026-07-31. The host's `nsul.db` was built from that archive on 2026-09-03.                                                              |
| Ofcom all-premises postcode files, version 2 (`_r2_`)                | 2026-01                     | 2026-07-07    | 2026-10-05    | The guide dates version 2 to 2026-07-07. The ZIP was last modified 2026-07-20.                                                                                           |
| Ofcom residential postcode files and both output-area files (`_r1_`) | 2026-01                     | 2026-05-13    | 2026-10-05    | The Spring 2026 update was published 2026-05-13, and the version 2 note lists no change to these files [inferred].                                                       |

### Flood zone at each planning grid reference

The dossier fixture `packages/opportunity-map/test/fixtures/london-three-buildings.ts` places each
building at its LDD grid reference, converted to WGS 84 with `osgb36ToWGS84` from
`@mailwoman/spatial/osgb36`. One run of `floodLayerReading` from `@mailwoman/flood/layer-readings` read
each point from the host's `flood.db` on 2026-10-05. The database's manifest gives layer
`flood-zones-ea-england`, version and source vintage `2026-05-20`, which is the Environment Agency
product's revision date, license `OGL-UK-3.0`, source
`environment.data.gov.uk/dataset/04532375-a198-476e-985e-0579a0a11b47`, and creation time
`2026-08-28T01:46:44.206Z`.

| Site | Grid reference | WGS 84 latitude, longitude               | Answer             | Layer reading                 | Claim                          |
| ---- | -------------- | ---------------------------------------- | ------------------ | ----------------------------- | ------------------------------ |
| A    | 533018, 165662 | 51.374440135180215, -0.09027853614389186 | designated absence | basis `designated`, 0 records | `flood_zone` `FZ1`, designated |
| B    | 524237, 186057 | 51.55972024704242, -0.2092077726372136   | designated absence | basis `designated`, 0 records | `flood_zone` `FZ1`, designated |
| C    | 530963, 183109 | 51.53170792370784, -0.1133329237818912   | designated absence | basis `designated`, 0 records | `flood_zone` `FZ1`, designated |

The zone is the zone that the Environment Agency's map assigns at the point. It describes the map rather
than a building's flood risk, and Zone 1 is silent about surface water, groundwater and residual risk in
defended areas.

## 4. Competition sources for each building

### Ofcom postcode and output-area rows (area context)

Each row states the share of the premises Ofcom assigns to that postcode or output area that had each
coverage level in January 2026. Ofcom names no network at these levels and withholds full-fibre
availability there. A postcode row carries no premises count. The NSUL UPRN count beside it is a
different register's count. None of these values is a result for the building. Columns: superfast
(30 Mbit/s), ultrafast (100 and 300 Mbit/s), gigabit, and premises unable to receive decent broadband.
For an output area, the premises count also gives the all-premises file's `Number of premises with
Gigabit availability`. The residential column reports whether Ofcom's residential file has a row for the
area.

| Site | Area      | Resolution  | Premises count                                          | SFBB % | UFBB 100 % | UFBB 300 % | Gigabit % | No decent % | Residential row                               |
| ---- | --------- | ----------- | ------------------------------------------------------- | ------ | ---------- | ---------- | --------- | ----------- | --------------------------------------------- |
| A    | CR0 5BX   | postcode    | unpublished (75 UPRNs in NSUL)                          | 100.0  | 100.0      | 100.0      | 100.0     | 0.0         | present, Gigabit 100.0                        |
| A    | CR0 5BY   | postcode    | unpublished (81 UPRNs in NSUL)                          | 100.0  | 100.0      | 100.0      | 100.0     | 0.0         | present, Gigabit 100.0                        |
| A    | CR0 5LP   | postcode    | unpublished (11 UPRNs in NSUL)                          | 100.0  | 0.0        | 0.0        | 0.0       | 0.0         | absent                                        |
| A    | E00005233 | output area | All Premises 509, All Matched Premises 509, Gigabit 371 | 100    | 72.9       | 72.9       | 72.9      | 0           | All Premises 447, Gigabit 81.2 (363 premises) |
| B    | NW2 2DL   | postcode    | unpublished (78 UPRNs in NSUL)                          | 100.0  | 100.0      | 100.0      | 100.0     | 0.0         | present, Gigabit 100.0                        |
| B    | NW2 2DW   | postcode    | unpublished (40 UPRNs in NSUL)                          | 100.0  | 100.0      | 100.0      | 100.0     | 0.0         | present, Gigabit 100.0                        |
| B    | NW2 2DP   | postcode    | unpublished (38 UPRNs in NSUL)                          | 100.0  | 96.4       | 96.4       | 96.4      | 0.0         | present, Gigabit 95.8                         |
| B    | E00178816 | output area | All Premises 127, All Matched Premises 127, Gigabit 126 | 100    | 99.2       | 99.2       | 99.2      | 0           | All Premises 122, Gigabit 99.2 (121 premises) |
| C    | N1 9FS    | postcode    | unpublished (37 UPRNs in NSUL)                          | 100.0  | 100.0      | 100.0      | 100.0     | 0.0         | present, Gigabit 100.0                        |
| C    | N1 9FT    | postcode    | unpublished (29 UPRNs in NSUL)                          | 100.0  | 100.0      | 100.0      | 100.0     | 0.0         | present, Gigabit 100.0                        |
| C    | N1 9FU    | postcode    | unpublished (33 UPRNs in NSUL)                          | 100.0  | 100.0      | 100.0      | 100.0     | 0.0         | present, Gigabit 100.0                        |
| C    | N1 9FW    | postcode    | unpublished (6 UPRNs in NSUL)                           | 100.0  | 100.0      | 100.0      | 100.0     | 0.0         | absent                                        |
| C    | N1 9JE    | postcode    | unpublished (8 UPRNs in NSUL)                           | 100.0  | 100.0      | 100.0      | 100.0     | 0.0         | absent                                        |
| C    | E00174805 | output area | All Premises 163, All Matched Premises 163, Gigabit 160 | 100    | 98.2       | 98.2       | 98.2      | 0           | All Premises 150, Gigabit 100 (150 premises)  |
| C    | E00174843 | output area | All Premises 88, All Matched Premises 88, Gigabit 82    | 100    | 93.2       | 93.2       | 93.2      | 0           | All Premises 74, Gigabit 94.6 (70 premises)   |

The queried key for each postcode row was the postcode in the `postcode_space` column of
`202601_fixed_pc_coverage_r2_<area>.csv` (all premises) and `202601_fixed_pc_coverage_res_r1_<area>.csv`
(residential). The key for each output-area row was the 2021 output-area code from ONSPD in the
`output_area` column of `202601_fixed_oa_coverage_r1.csv` and `202601_fixed_oa_res_coverage_r1.csv`.
Every lookup ran on 2026-10-05 against the ZIP retrieved that day.

Withheld or absent at this level: the premises count for each postcode, every network's name, full-fibre
availability, and the per-UPRN, per-provider records that Ofcom holds and withheld under section 393(1)
of the Communications Act 2003.

### Per-address and licensed sources (unattempted)

These sources take an address, a UPRN or a postcode and can return a result for the building itself.
This pass attempted none of them. The status, key and governing term are the same for all three
buildings. Each term was read on 2026-10-05.

| Source                                | Key it takes                                        | Status                                                   | Term that governs reuse                                                                                                                                                    | Withheld or unknown                                                                 |
| ------------------------------------- | --------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Ofcom broadband checker               | postcode, then one address                          | unattempted: consumer checker                            | Ofcom site terms: reproduction "provided that it is reproduced accurately and not used in a misleading context" (`ofcom.org.uk/about-ofcom/our-website/terms-of-use`)      | names of networks that have not consented to be named                               |
| Ofcom Connected Nations Broadband API | postcode (`GET /coverage/{PostCode}`), per UPRN     | unattempted: needs a registered key and approval         | Ofcom API terms of use 2025, clause 4.3.6, which bars storing the information "to build a partial or full dataset of your own" and limits a performance cache to one month | every network's name: the schema has no such field                                  |
| thinkbroadband API                    | postcode, and a UPRN for some networks [unverified] | unattempted: needs a license; its page returned HTTP 403 | unread                                                                                                                                                                     | fields, coverage, price and report rights                                           |
| Openreach checker                     | address                                             | unattempted: consumer checker                            | "not designed for managing automated process such as macros and robots"; content "provided solely for your own use", republication prohibited (`openreach.com`)            | other networks; per-record dates                                                    |
| Virgin Media checker                  | address                                             | unattempted: consumer checker                            | "No information or material on a Virgin Media Site may be copied, reproduced or downloaded without Virgin Media's express permission in writing" (`virginmedia.com`)       | other networks; orderability "subject to survey, network capacity and credit check" |
| CityFibre checker                     | address                                             | unattempted: consumer checker                            | personal use of the site only; copying, distributing or publishing content needs "our prior written consent" (`cityfibre.com`)                                             | other networks                                                                      |
| Community Fibre checker               | address                                             | unattempted: consumer checker                            | unknown: the legal page holds no website-terms text that this pass found (`communityfibre.co.uk/legal-stuff`)                                                              | other networks                                                                      |

The Ofcom checker is the discovery step for networks beyond these four operators, because it names
every consenting network at an address. A network it omits stays unknown.

## 5. Operator actions

Each action needs a person, a registration or a license, so this pass leaves it to the operator.

1. Ofcom checker, by hand: enter each of the nine postcodes (CR0 5BX, CR0 5BY, NW2 2DL, NW2 2DW, N1 9FS,
   N1 9FT, N1 9FU, N1 9FW and N1 9JE), choose the building's addresses from the list, and record each
   address string, its speed categories, the networks named and the date.
2. Each network the Ofcom checker names, and the Openreach, Virgin Media, CityFibre and Community Fibre
   checkers, by hand for the same addresses: record the address string the checker matched, the
   returned state and the date. Read each operator's site terms first. Openreach, CityFibre and Virgin
   Media bar republication without permission, so keep the returned wording internal unless that
   operator permits publication.
3. Ofcom API: register at `api.ofcom.org.uk` and apply for the Broadband Coverage Basic product if
   per-UPRN predicted speeds are wanted, after reading the 2025 terms, clauses 4.2 and 4.3.
4. thinkbroadband: read the API page and its license in a browser, then ask for the price, coverage of
   the nine postcodes, and a license that permits an operator-facing report on three buildings.
5. GLA: ask the GLA's planning team to state the license of the PLD's records, so that a later pass can
   use its daily data.

## Attribution

```text
Ofcom, Connected Nations update Spring 2026, fixed coverage data (January 2026). © Ofcom.
Licensed under the Open Government Licence v3.0.

Greater London Authority, London Development Database planning permissions and referred planning
applications since 2011, London Datastore. Licensed under the Open Government Licence v3.0.

ONS Postcode Directory (February 2026): Contains OS data © Crown copyright and database right 2026.
Contains Royal Mail data © Royal Mail copyright and database right 2026. Source: Office for National
Statistics licensed under the Open Government Licence v.3.0.

National Statistics UPRN Lookup (June 2026, Epoch 127): Contains OS data © Crown copyright and database
right 2026. Contains Royal Mail data © Royal Mail copyright and Database right 2026. Contains GeoPlace
data © Local Government Information House Limited copyright and database right 2026. Source: Office for
National Statistics licensed under the Open Government Licence v.3.0.

Environment Agency, Flood Map for Planning, revision 2026-05-20: © Environment Agency copyright and/or
database right 2025. All rights reserved. Licensed under the Open Government Licence v3.0.
```

## Source register

- London Datastore entries `2jxq0` (LDD) and `2w1xz` (referred applications) and their files —
  2026-10-05
- planning.data.gov.uk planning-application dataset page and entity API — 2026-10-05
- ONS Postcode Directory, February 2026 (host copy retrieved 2026-07-22), and its ONS portal item —
  2026-10-05
- National Statistics UPRN Lookup, June 2026 (host database built 2026-09-03), and its ONS portal item —
  2026-10-05
- ONS page on the licensing of its geography products (`ons.gov.uk/methodology/geography/licences`) —
  2026-10-05
- Ofcom Spring 2026 fixed coverage ZIP and its version 2 guide — 2026-10-05
- Ofcom website terms, checker FAQ, API portal and API terms of use 2025 — 2026-10-05
- Openreach, CityFibre and Virgin Media website terms; Community Fibre legal page — 2026-10-05
- thinkbroadband Broadband Availability API page (HTTP 403, unread) — 2026-10-05
- Environment Agency Flood Map for Planning, revision 2026-05-20, as built into the host's `flood.db`
  (created 2026-08-28) — 2026-10-05
