# Land arability and soils as a spatial layer — source survey and two-consumer design

This is the design record for #1984. It is a survey rather than a builder. It settles which authorities
publish land-capability and soils data we could carry, what each one's own words permit and forbid, what a
layer built from one would be allowed to claim, and which single source and region the first build should
take. The builder is a follow-up issue, outlined in §7 and not filed here.

This survey answers one question the flood survey did not have to: **how one acquisition serves two
consumers.** A result-level land-capability observation needs a single reading for a resolved coordinate.
#1683's activity-affordance vector needs a per-cell signal that can sit beside light, dwellings and amenity
density. §4 exists to prevent acquiring the same national datasets twice, with two aggregation choices that
can never be reconciled cell for cell.

The consuming implementation already exists, so no section below proposes new architecture. The layer interface
(`layer_manifest` / `layer_coverage` on the H3 spine) is specified in
[`../../engineering/reference/layer-interface.mdx`](../../engineering/reference/layer-interface.mdx);
`packages/bdc` is the worked federal-provider example. The exclusion-grade coverage pilot
([`2026-08-27-exclusion-grade-coverage-pilot.md`](./2026-08-27-exclusion-grade-coverage-pilot.md)) sets
the coverage-basis rules. The flood survey
([`2026-08-27-flood-layer-survey.md`](./2026-08-27-flood-layer-survey.md)) is this record's structural
template. `packages/mailwoman/lib/observations/absence-route.ts` and its `QueryIntentMarker` carrier
deliver an additive advisory with provenance, without changing ranking.

**Every external claim below carries its URL and the date it was read.** Measurements taken from this
lab are labeled as measurements and give the command's answer rather than a summary of it. A fact that
could not be established from a primary source is listed in §8 as unverified, with what was tried. No
entry in §8 was filled in with a plausible guess.

## 1. What this record settles, and what it deliberately does not

Settled here: the verified inventory (§2), what each source's own coverage statement licenses a
`layer_coverage` row to say (§3), which storage shape each source takes and why (§4.3), the two-consumer
schema with its aggregation choice and the information that choice discards (§4.4–§4.6), the pilot's
source, region and verification ladder (§5), and the product requirement (§6).

The following are not settled here. They are listed so nobody reads silence as a decision:

- The H3 resolution the layer is built at. **§4.7 lists the four candidates and the two numbers the
  pilot must report at each, and the pilot chooses from that measurement.** §4.4 establishes only that
  no affordable resolution removes the mixture.
- The spine-key declaration for a polygon-derived cell layer (§4.7). The flood survey left the same
  question open, and one answer will serve both.
- Whether the observation's advisory code extends the existing query-intent vocabulary or widens the
  carrier (§5.5, also shared with the flood survey).
- The fitting question of whether the result adds information beyond the signals #1683 already lists.
  #1684 owns that measurement.

The issue puts three things out of scope, and this record leaves them out: the builder itself, any
fitting work, and any authored land-use judgment beyond what the source states. The layer records what an authority states, in the authority's
vocabulary, with the authority's dates. It computes no suitability score of its own.

## 2. Source inventory

### 2.1 United States — USDA NRCS soil survey (SSURGO) and Soil Data Access

All facts in this section read or measured **2026-08-27**.

**Reachability comes first because it is the reason this source is the pilot.** The issue warned that
US federal hosts may reset TLS from this network, as FEMA's three distribution hosts did in the flood
survey. **The USDA soil hosts do not.** Measured from this lab with `curl`:

| host                             | result                                |
| -------------------------------- | ------------------------------------- |
| `sdmdataaccess.nrcs.usda.gov`    | HTTP 200 in 0.84 s (199.135.69.138)   |
| `sdmdataaccess.sc.egov.usda.gov` | HTTP 200 in 0.44 s                    |
| `websoilsurvey.nrcs.usda.gov`    | HTTP 302 → `/app` (199.135.69.180)    |
| `websoilsurvey.sc.egov.usda.gov` | HTTP 200, served a real 25 MB archive |
| `gdg.sc.egov.usda.gov`           | HTTP 301                              |
| `nrcs.app.box.com`               | HTTP 302                              |
| `www.nrcs.usda.gov`              | needs browser headers — see below     |

`www.nrcs.usda.gov` is the one weak point, and it is the content site rather than a distribution host.
It first looked intermittent against an Akamai edge (`e11492.dscb.akamaiedge.net`, 184.87.188.132): an
HTTP/2 request returned 200 on retry while `--http1.1` timed out at 25 s. The cause turned out to be
deterministic. **The host requires a browser-like header set** (a normal `User-Agent` plus `Accept` and
`Sec-Fetch-*`), and a plain client hangs after the TLS handshake instead of being refused. The host is
neither blocked nor affected by a network problem. **Every distribution endpoint an ingest would call
was reachable.**

**Soil Data Access is a live, anonymous SQL service, and it answers.** A `POST` to
`https://sdmdataaccess.nrcs.usda.gov/Tabular/post.rest` with
`{"SERVICE":"query","FORMAT":"JSON","QUERY":"…"}` returned `{"Table":[[…]]}` in **0.374 s** without a
key, an account or a rate-limit header. Every tabular measurement in this record was taken through it.
Its spatial functions also work: `SDA_Get_Mukey_from_intersection_with_WktWgs84('point(-93.6 41.9)')`
returned mukey `2765537` in **1.807 s**, and `SDA_Get_MupolygonWktWgs84_from_Mukey(408511)` returned a
real WKT polygon. That gives a second, independent path for checking a built artifact, the role the EA's
WFS plays in the flood survey's ladder.

Whoever writes the client should know three measured traps:

- **Failures come back as XML rather than JSON.** A timeout, a bad column and a blocked query all return an
  OGC `ServiceExceptionReport` document. Observed messages: `"Your query timed out."` (a `GROUP BY` over
  `cointerp`), `"Invalid query: Invalid column name 'tabularversion'."` (HTTP 400), and
  `"Invalid query - access denied."`. A client that assumes JSON on a 200 will mis-read the first two.
- **Schema introspection is refused.** `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS` returns
  `"Invalid query - access denied."`, so the published Data Dictionary is the only schema source. The
  service cannot report its own columns.
- **The service has a server-side query timeout** with no published value. An aggregate over
  `cointerp`'s ~12 M rows exceeded it, and the same aggregate narrowed by `mrulename` and `rulename`
  succeeded.

**License: the metadata, rather than data.gov, contains a public-information statement.** Here the naive
reading and the verified one differ, in the opposite direction from FEMA.

<!-- vale off -->

data.gov's entry
([catalog.data.gov/dataset/soil-survey-geographic-database-ssurgo](https://catalog.data.gov/dataset/soil-survey-geographic-database-ssurgo),
identifier `430-14-14`, publisher Natural Resources Conservation Service, `datePublished` 2025-10-01,
`dateModified` 2026-07-02) carries `"license": "https://www.usa.gov/publicdomain/label/1.0/"` in its
embedded JSON-LD. **That URL is not a grant.** It redirects to
[usa.gov/government-copyright](https://www.usa.gov/government-copyright), the same page the flood survey
found behind FEMA's license field, which declines a blanket grant: a government work is "something
created by a U.S. government officer or employee as part of their official duties", but "Content on
federal websites may include protected intellectual property used with the right holder's permission",
and the reader is told to "Check with the federal agency or program that manages the website to make
sure the materials are not restricted before using them."

<!-- vale on -->

The agency was therefore checked at the strongest available source: **the FGDC metadata NRCS ships inside
the data archive itself** (`IA153/soil_metadata_ia153.xml`, extracted from the survey-area download measured
below). Access constraints are `None`. The use constraints, verbatim and complete in the parts that
bind:

> "The U.S. Department of Agriculture, Natural Resources Conservation Service, should be acknowledged
> as the data source in products derived from these data. This data set is not designed for use as a
> primary regulatory tool in permitting or citing decisions, but may be used as a reference source.
> **This is public information and may be interpreted by organizations, agencies, units of government,
> or others based on needs; however, they are responsible for the appropriate application.**"

and, on distribution liability:

<!-- vale off -->

> "Although these data have been processed successfully on a computer system at the U.S. Department of
> Agriculture, no warranty expressed or implied is made by the Agency regarding the utility of the data
> on any other system, nor shall the act of distribution constitute any such warranty."

<!-- vale on -->

"This is public information" is an affirmative statement about the data, made by the producing agency,
in the file it ships. That is materially stronger than FEMA's "acknowledgement of FEMA would be
appreciated", which the flood survey correctly declined to read as a license. Together with an
acknowledgement request and a liability clause that contemplates redistribution, it gives a `shipped`
layer the license position it needs. The acknowledgement string the layer must carry is the agency name as the
metadata gives it: **U.S. Department of Agriculture, Natural Resources Conservation Service.**

**The caveats in the same paragraph are binding, and §3 applies them.** Two sentences constrain what
any consumer may do with a point:

> "Photographic or digital enlargement of these maps to scales greater than at which they were
> originally mapped can cause misinterpretation of the data. If enlarged, maps do not show the small
> areas of contrasting soils that could have been shown at a larger scale."

> "The depicted soil boundaries, interpretations, and analysis derived from them do not eliminate the
> need for onsite sampling, testing, and detailed study of specific sites for intensive uses. Thus,
> these data and their interpretations are intended for planning purposes only."

One sentence governs freshness: "Digital data files are periodically updated. Files are dated, and users are
responsible for obtaining the latest version of the data."

**Extent, measured through SDA — and the count is off by one against NRCS's own figure, which is
reported rather than reconciled.** `SELECT COUNT(*) FROM sacatalog` returns **3,380 rows**, and the
soil survey availability map's categories also sum to 3,380 (3,342 + 23 + 15). But NRCS's **2025 Annual
Soils Refresh** document states **3,379 soil survey areas published**, and that figure is corroborated
independently by SDA itself: 3,379 legends of type `Non-MLRA Soil Survey Area`. Two of the three paths
agree at 3,379. The difference is one area, and no decision in this record depends on it. A builder
counting survey areas should still expect 3,379 published and know that `sacatalog` holds one more row.
Below, 3,380 is used where the figure is a `sacatalog` measurement, because that is what was measured.

Those rows span **61 state and territory prefixes**: Texas 232, Alaska 137, California 120, down to single
areas for Guam, American Samoa, Palau, the Marshall Islands and the Federated States of Micronesia (4).
`SELECT COUNT(*) FROM mapunit` returns **339,191 map units**, and two independent aggregations each
summed to the same figure. `component` holds **1,288,808 rows**.

**Cadence — one coordinated annual refresh on a fixed date, and the refresh date is not the survey
date.** NRCS states the schedule in its own words on the
[Annual Soils Refresh page](https://www.nrcs.usda.gov/conservation-basics/natural-resource-concerns/soil/annual-soils-refresh):

> "Each year on October 1, the USDA NRCS Soil and Plant Science Division performs an Annual Soils
> Refresh (ASR) of the publicly available soil survey database…"

> "The most recent ASR made new and updated data available on October 1, 2025."

and it says how much moves: "approximately 10 to 20 percent of soil survey areas will have more
measured changes". The 2025 refresh added 41,974,803 acres of new soil data, 116,727 new polygons and
2,227 new map units.

The measurement agrees with the statement. Grouping `sacatalog` by `YEAR(saverest)` returns
**2016: 1, 2025: 3,323, 2026: 56**, so 98.3 % of areas carry a version-established date from one
refresh rather than drifting per area. **The current vintage is the
October 1, 2025 refresh.** NRCS uses no fiscal-year label for it; five primary sources were checked for
one and none appears, so a manifest must not invent an `FY` string.

A uniform refresh makes the manifest vintage easy and makes the currency claim dangerous, because the
underlying survey is far older. One real survey area, Polk County, Iowa (`IA153`), has
`sacatalog.saverest` **2025-09-09**, version 28. Its shipped metadata cites these sources:

| source                                  | scale    | date       |
| --------------------------------------- | -------- | ---------- |
| Soil Survey of Polk County, Iowa        | 1:15,840 | 1960       |
| multiple photographs / orthophotographs | 1:12,000 | —          |
| annotated overlay                       | 1:12,000 | 1996       |
| NASIS database for Polk County, Iowa    | —        | 2002       |
| SSURGO database for Polk County, Iowa   | —        | 1998, 2009 |

**The field survey behind a polygon republished in 2025 was published in 1960.** The dataset's own
`<enddate>` is `20250909`, which is the refresh date. A consumer that reads the time period of content
as the survey's currency is therefore wrong. The manifest's `source_vintage` must be the refresh. The
per-survey-area survey date is a separate fact that the metadata carries, and the layer should carry it
too.

Positional accuracy, verbatim from the same metadata: "The accuracy of these digital data is based upon
their compilation to base maps that meet National Map Accuracy Standards at a scale of 1 inch equals
1,000 feet. The difference in positional accuracy between the soil boundaries and special soil features
locations in the field and their digitized map locations is unknown." Maintenance frequency is
`As needed`, the same absence of a schedule the EA publishes.

**Formats, acquisition and sizes, exercised end to end.** The download service is documented at
[websoilsurvey.sc.egov.usda.gov/DSD/Download/help](https://websoilsurvey.sc.egov.usda.gov/DSD/Download/help),
which lists `GET /{CacheName}/{FileName}` and `GET /{CacheName}/{SubFolder}/{FileName}`. The filename
embeds the survey area's version date, **and SDA supplies that date**. `sacatalog.saverest` for `IA153`
is 2025-09-09, and with that date both of these return HTTP 200:

| URL under `…/DSD/Download/Cache/SSA/`           | bytes          | difference                       |
| ----------------------------------------------- | -------------- | -------------------------------- |
| `wss_SSA_IA153_[2025-09-09].zip`                | **25,474,922** | data only                        |
| `wss_SSA_IA153_soildb_IA_2003_[2025-09-09].zip` | **27,598,377** | adds the `soildb_*.mdb` template |

**The two filename shapes are two cache variants of the same survey area, differing by the Access
template database.** A second area confirms this. `wss_SSA_IA015_soildb_IA_2003_[2025-09-08].zip` is
41,104,724 bytes with 98 entries including `soildb_IA_2003.mdb`, against 38,981,269 bytes for the bare
form. `wss_SSA_TX299_[2025-09-04].zip` is 13,455,641 bytes with 97 files and no `.mdb` at all. **A
builder should take the bare form.** The template is an empty Access container for a workflow we do not
use.

A wrong date returns HTTP 400 rather than 404. The square brackets need `--globoff` or `%5B`/`%5D`. The archive holds
ESRI shapefiles under `spatial/` (`soilmu_a` map-unit polygons, `soilmu_l`/`soilmu_p` lines and points,
`soilsa_a` survey-area outline, `soilsf_*` special features), the full NASIS tabular export as
pipe-delimited `.txt` under `tabular/`, and both `.txt` and `.xml` FGDC metadata. The projection file
reads `GEOGCS["GCS_WGS_1984",…]`. The data is **geographic WGS84, so it needs no reprojection before
H3**, which takes WGS84 latitude and longitude.

The download has one acquisition trap, the same one the flood survey found on the Environment Agency's
host: **`HEAD` returns HTTP 405 (`allow: GET`) and `Range` is ignored.** A request with
`Range: bytes=0-0` returned HTTP 200 and transferred the whole 27,598,377 bytes in 7.23 s at 3.8 MB/s. A
builder therefore cannot check freshness by content length. It does not need to, because
`sacatalog.saverest` answers the freshness question directly through the tabular service. The `Range`
behavior is **path-specific** rather than host-wide. The `/DataAvailability/` path does honour it
(HTTP 206), so a client must probe each path separately. The server is `Microsoft-IIS/10.0` behind an AWS load balancer.

**The arability attributes, with their measured shape.** Each column name was verified by querying it
successfully through SDA:

- `mapunit.farmlndcl` — Farmland Classification. **23 distinct values plus NULL (11,486 map units).**
  The top values are `Not prime farmland` (192,120), `All areas are prime farmland` (48,253),
  `Farmland of statewide importance` (46,754), `Prime farmland if drained` (15,253), `Prime farmland if
irrigated` (10,833), `Farmland of local importance` (5,481). **The vocabulary is conditional**. A
  long tail reads `Prime farmland if drained and either protected from flooding or not frequently
flooded during the growing season`, `Prime farmland if irrigated and reclaimed of excess salts and
sodium`, `Prime farmland if subsoiled, completely removing the root inhibiting soil layer`. A boolean
  `arable` column would be this record's invention rather than the authority's statement.
- `component.nirrcapcl` / `component.nirrcapscl` — nonirrigated Land Capability Class (`"1"`…`"8"`) and
  subclass (`c`, `e`, `s`, `w`). **NULL on 220,013 of 1,288,808 components (17.1%).**
- `component.irrcapcl` / `component.irrcapscl` — the irrigated rating. **NULL on 1,097,370 components
  (85.1%).** It is populated only where irrigation is a considered use, so its absence says the rating
  does not apply to that land.
- `component.comppct_r` — the component's percentage of the map unit. This is the weight §4.4 uses.
- `muaggatt.niccdcd` / `muaggatt.niccdcdpct` — NRCS's **own** aggregation of the capability class to the
  map unit by dominant condition, **shipped with the share that class covers**. §4.4 adopts this
  pattern, and it is the most useful precedent in the source.
- `cointerp` — the National Commodity Crop Productivity Index. Measured rule names and row counts:
  `NCCPI - National Commodity Crop Productivity Index (Ver 3.0)` (7,111,314), plus submodels for small
  grains (1,386,363), soybeans (1,190,601), corn (1,188,834), cotton (307,715) and an
  `Irrigated National Commodity Crop Productivity Index` (1,091,490). The v3.0 overall condition is true
  1,185,219 rows with `interphr` ranging **0.001 to 0.991**, so it is an index in [0, 1] rather than a
  percentage.

**Federal regulation defines two categories of the Farmland Classification vocabulary, and state or
local agencies define the others.** That determines whether it can be compared across the country. From
7 CFR 657.5, read from the
[govinfo CFR granule](https://www.govinfo.gov/content/pkg/CFR-2024-title7-vol6/xml/CFR-2024-title7-vol6-sec657-5.xml)
(HTTP 200), prime farmland is defined nationally as "land that has the best combination of physical and
chemical characteristics for producing food, feed, forage, fiber, and oilseed crops, and is also
available for these uses", with nine specific criteria covering moisture regime, temperature
regime, pH between 4.5 and 8.4, water table, salinity, flooding frequency, erodibility, permeability and
rock-fragment content. Unique farmland is also defined nationally. The other two categories are not:

> "(c) **Additional farmland of statewide importance.** … Criteria for defining and delineating this
> land are to be determined by the appropriate State agency or agencies."

> "(d) **Additional farmland of local importance.** … Where appropriate, these lands are to be
> identified by the local agency or agencies concerned."

**`Farmland of statewide importance` therefore makes a different claim in Iowa than in Georgia.** A layer
that pooled them into one rank would do what the EU flood viewer warns against between member states.
Prime and Unique mean the same thing everywhere, and statewide and local importance do not. The stored
vocabulary must keep that distinction as well as this document.

**The raster and coarse siblings, and why the pilot does not take them.** The SSURGO survey-area download
plus SDA is a complete acquisition path that was exercised, so none of the following is needed. Each was
checked far enough to keep a builder from choosing the wrong one.

- **gSSURGO** is the gridded derivative, and its resolution depends on which file you take: "The raster
  map data have a 10-meter cell size that approximates the vector polygons in an Albers Equal Area
  projection" **per state**, while "Due to file size, the raster layer for the conterminous United States
  is only available in a 30-meter resolution." **gNATSGO** matches: "The map unit grid is 10 meters for
  State databases and 30 meters for large databases". Both are **raster**, so §4.3's raster rule would
  govern them, and both are in a projected CRS, unlike the WGS84 vector product.
- **gNATSGO's container changed**, and older descriptions are stale: "The gNATSGO database uses the
  GeoPackage version of the SQLite SSURGO Template schema … The spatial soils data are delivered as
  raster files but exist outside of the database as GeoTIFFs", with "no vectorized version of the soil
  map unit included in gNATSGO". A builder written against the ESRI file-geodatabase description would be
  writing against a format that is no longer shipped.
- **These are distributed through Box, which refuses anonymous programmatic download (HTTP 403).** The
  sizes available are Box's own `itemSize` metadata rather than HTTP measurements, and are labeled as
  such: gSSURGO CONUS 24.44 GB, the all-SSURGO GeoPackage 35.75 GB, gNATSGO 7.90 GB, per-state gSSURGO
  from 25.5 MB (Rhode Island) to 1.74 GB (Minnesota). The gridded products lag the October 1 refresh.
  Observed artifact dates run from 2025-11-19 to 2026-02-17, a lag of roughly six weeks to four months.
- **STATSGO2** is the 1:250,000 coarse companion: "Spatial data are available in ESRI shapefile format.
  … Tabular data are available as ASCII text files (.txt). Fields are pipe delimited". Every distributed
  STATSGO2 file on both hosts is pinned at `[2016-10-13]`. One provenance finding matters: **the two
  hosts serve different byte streams for what is nominally the same national file**. Box metadata
  reports 446,108,728 bytes, and the Web Soil Survey cache measured 445,366,221 bytes. A builder must
  record which host its copy came from.
- **The Geospatial Data Gateway** answers HTTP 301 and was not exercised. Its ordering flow is
  unverified (§8).

One acquisition detail also explains a measurement above: **`www.nrcs.usda.gov` requires browser-like
request headers.** A plain `curl` or fetcher hangs after the TLS handshake, and adding a normal browser
`User-Agent`, `Accept` and `Sec-Fetch-*` set makes it answer. That explains the "intermittent" row in
the reachability table, and it constrains any automated ingest that reads NRCS content pages. The
distribution hosts do not have this requirement.

### 2.2 United States — USDA NASS Cropland Data Layer

All facts in this section read or measured **2026-08-27**.

**Reachability is split, and the split matters.** The bulk archive host answers, and the interactive
web-service host does not.

- `www.nass.usda.gov` — HTTP 200 (20.140.151.75). The release index at
  [`/Research_and_Science/Cropland/Release/index.php`](https://www.nass.usda.gov/Research_and_Science/Cropland/Release/index.php)
  served normally.
- **`nassgeodata.gmu.edu` — port 443 is dead, and port 8080 answers with responses that settle the
  question.** On 443, TCP accepts in 0.085 s and the TLS handshake never completes.
  `openssl s_client -connect 129.174.131.7:443` timed out at 30 s (exit 124) after receiving **zero
  bytes**, and three `curl` attempts each timed out at 20 s. Port 80 answers HTTP 302 and redirects to
  the same dead 443, a closed loop. DNS resolves directly. The failure is a TLS stall without any
  error, rather than a reset or a resolution failure, and the host belongs to **George Mason
  University** rather than a federal agency.

  **Port 8080 is alive.** The Axis2 SOAP container serves the CropScape `CDLService` WSDL at
  `http://nassgeodata.gmu.edu:8080/axis2/services/CDLService?wsdl` (HTTP 200, 26,467 bytes, connect
  0.088 s, `Server: Apache-Coyote/1.1`). It advertises seven operations: `ExtractCDLByValues`,
  `GetCDLComp`, `GetCDLFile`, `GetCDLImage`, `GetCDLPDF`, `GetCDLStat`, `GetCDLValue`. Six of the seven
  match the NASS-authored program paper hosted on NASS's own reachable server
  ([2012_CropScape.pdf](https://www.nass.usda.gov/Research_and_Science/Cropland/docs/2012_CropScape.pdf),
  HTTP 200, 4,956,960 bytes; Han, Yang, Di and Mueller, _Computers and Electronics in Agriculture_
  84:111–123).

  **Every data-returning operation fails server-side.** The paper's own example call returns HTTP 500
  with `Cannot run program "D:/CDL/CDLUtlis_win/gdal_getvalue.exe" (in directory "D:\CDL\var\tmp"):
CreateProcess error=267, The directory name is invalid`. All seven were exercised. Each fails on a
  missing Windows-side executable (`gdal_getvalue.exe`, `C:/GDAL/ogrinfo.exe`,
  `C:/GnuWin32/bin/bat/wget.bat`), except `GetCDLPDF`, which fails schema validation. The service
  dispatches, validates schemas, and enforces its own year range before the process launch fails. A
  blocked port cannot produce a `CreateProcess` fault string, so **the failure is in the backend rather
  than this network**. The year range is a separate limit. Out-of-range years are rejected with
  `"Error: The year must be between 1997 and 2019."`, which is **six crop years behind the shipped 2025
  CDL** even if the backend were repaired. The WSDL's own SOAP binding address uses port 80, which
  redirects to the dead 443, so the only working entry is the explicit `:8080`.

  **Treat the CropScape API as unavailable for data retrieval.** It can be reached, but it answers and
  then fails. NASS publishes no decommissioning statement. This absence was checked: the FAQ, last
  modified 2026-05-06, mentions CropScape once, in the past tense. The successor is
  [CroplandCROS](https://croplandcros.scinet.usda.gov/) (HTTP 200), whose REST API requires an ArcGIS token
  and whose REST root could not be enumerated (§8). **The bulk file path on `www.nass.usda.gov` is
  unaffected and is the only acquisition route a builder should plan on.**

**License: CC0, and unlike SSURGO's field it is a complete grant by itself.** The NASS data.gov entry
([catalog.data.gov/dataset/cropland-data layer](https://catalog.data.gov/dataset/cropland-data-layer),
identifier `USDA-NASS-00004`, publisher National Agricultural Statistics Service, `datePublished`
2026-02-27, `dateModified` 2026-05-04) carries
`"license": "http://creativecommons.org/publicdomain/zero/1.0/"` in its embedded JSON-LD. That URL
resolves (HTTP 200) to the Creative Commons CC0 1.0 Universal deed itself, which is an affirmative
worldwide dedication rather than a pointer back to an agency. This survey and the flood survey compared
three US license fields: FEMA's, SSURGO's and the CDL's. **Only the CDL's link leads to a real
license.**

**Extent, formats and sizes, measured.** The release index lists **18 CONUS-wide years, 2008 through
2025**, as `datasets/<year>_30m_cdls.zip`, plus nine regional `CDL10_<region>.zip` files. Sizes taken
by ranged GET (this host **does** honour `Range` — HTTP 206 with `content-range`, unlike the soil
host):

| year | bytes             |
| ---- | ----------------- |
| 2008 | 1,813,824,795     |
| 2020 | 2,007,640,337     |
| 2024 | 1,656,243,429     |
| 2025 | **1,887,184,211** |
| 2026 | HTTP 404          |

The missing 2026 file and the data.gov `datePublished` of 2026-02-27 both fit the annual pattern: a
growing season is published in the following calendar year. The 2025 layer is the current one.

**What it is, and the semantic difference from a soil survey.** The CDL is a 30 m classified raster of
**what was observed growing in one season**. A soil survey records what the land is capable of. Those
are different questions, and the difference shapes §4. A CDL cell that says "not cropped in 2025" does
not say the land cannot be cropped, and no field in the product distinguishes fallow land, pasture, a
parking lot, and a field the classifier got wrong. The per-class accuracy metadata, the projection, the
full class-value table and NASS's own use caveats are in §8 as unverified. The two facts the pilot
decision needs (license and reachability) are verified above.

**Why it is not the pilot: the reason is structural rather than a preference.** A CDL ingest is a
raster ingest, and **this repository has no raster tooling at all.** Two checks confirm this: no
`geotiff`, `gdal`, `rasterio`, `proj4` or `sharp` entry appears in any workspace `package.json`, and
none appears in `yarn.lock`. The repository does use `ogr2ogr` as an external binary (the `tiger` SDK
and the corpus adapters), but that is a **vector** path. SSURGO ships shapefiles in WGS84; the CDL ships a
projected raster. The first arability layer should not also be this repository's first raster pipeline
and its first reprojection.

### 2.3 EU level — the open layer has no soil in it, and the soil layer may not be redistributed

All facts in this section read **2026-08-27**. Both `land.copernicus.eu` (HTTP 302) and
`esdac.jrc.ec.europa.eu` (HTTP 200) are reachable from this lab, so the findings here concern licensing
and content rather than reachability. In this section a plausible guess would have been wrong.

**The main finding: no pan-EU, downloadable, redistributable, survey-based land-capability layer
comparable to SSURGO exists.** The absence was established by enumeration rather than by search. All
241 CLMS datasets were listed and pattern-matched, all 158 ESDAC catalogue entries were listed and
keyword-searched, and the EEA SDI catalogue was phrase-searched. "land capability", "soil suitability",
"land suitability", "soil productivity", "crop suitability" and "soil fertility" each return **zero**
records. The reason is structural: **the EU splits what SSURGO combines. The open, redistributable
products carry no soil data, and the soil products are not redistributable.**

<!-- vale off -->

**Copernicus Land Monitoring Service: open, with no soil-quality product.** The earlier finding this
survey was asked to test holds, with one correction to its precision. The data policy
([land.copernicus.eu/en/data-policy](https://land.copernicus.eu/en/data-policy), HTTP 200) states that
products are available "on a principle of full, open and free access, as established by the Commission
Delegated Regulation (EU) No 1159/2013 of 12 July 2013", and the page names **no Creative Commons
license at all**. The Regulation's own text
([EUR-Lex CELEX:32013R1159](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32013R1159),
HTTP 200) grants what an open license grants and imposes similar conditions. Article 7 permits "reproduction", "distribution", "communication to the public", "adaptation, modification and
combination with other data and information", "worldwide without limitations in time". Article 8
requires that users "inform the public of the source", "make sure not to convey the impression to the
public that the user's activities are officially endorsed by the Union", and "clearly state" any
adaptation. Article 9 disclaims all warranty. **It is a bespoke EU instrument that works like an open
license, and it is distinct from CC BY.** A manifest that recorded it as CC BY would be recording a
license nobody granted.

<!-- vale on -->

The correction: **the Regulation mandates the login requirement**, so it is not an implementation choice.
Article 18(1) says "To access download services, users shall register online … Registration shall be free
of charge", and Article 18(2) says "**No registration shall be required for discovery services and view
services.**" The measured behavior matches that split. Anonymous `@search` returns HTTP 200 and the
CLC2018 ArcGIS view service returns HTTP 200, while `@datarequest_post`, `@projections` and
`@format_conversion_table` each return **HTTP 401** `{"message": "You are not authorized to access this
resource."}`. Registration is EU Login, and downloads are a request-then-poll flow carrying a bearer
token. **An unattended anonymous bulk pull is not possible.** That constrains a builder, but it is a
different kind of constraint from a license problem.

What CLMS holds: CORINE Land Cover in **five editions only — 1990, 2000, 2006, 2012, 2018**
(CLC2024 is "scheduled for publication in Q3 2026", the current quarter, and is not in the catalogue),
44 level-3 classes, **25 ha minimum mapping unit** and 100 m minimum width, 5 ha for change layers,
EPSG:3035, thematic accuracy "≥ 85%". The arable family is **2.1 Arable land** (211 Non-irrigated
arable land, 212 Permanently irrigated land, 213 Rice fields), and CLMS states that "Crop types
(e.g. wheat, corn...) are not distinguished in CORINE Land Cover." CLC+ Backbone is a 10 m raster with
**11 classes**, of which only "Periodically herbaceous" is arable-adjacent. It **complements rather
than replaces** CLC. The source says "It is designed to complement the well-known CORINE Land Cover time
series", and CLC2024 proceeding on unchanged 25 ha specifications is consistent with that. Six High
Resolution Layers exist, including a new HRL Croplands at 10 m with a 0.25 ha minimum unit.

**A soil-quality or land-capability product is absent from CLMS entirely.** Every "soil" match across
all 241 datasets is soil _moisture_ or the Croplands bare-soil phenology layers. CLMS ships land cover
and cropping practice; soil properties live at the JRC.

**ESDAC (JRC) — the EU's soil data home, and its terms forbid redistribution.** This finding determines
whether anything can be published, and it applies per dataset rather than site-wide. **ESDAC has no
site-wide data policy page** (18 candidate URLs each returned HTTP 404), because the operative terms are
per-dataset "Notification" blocks that differ from one another. Most datasets require a request form naming the
"Purpose for which the data will be used".

- **European Soil Database v2.0**, the pan-EU soil map, is **1:1,000,000**, two orders of magnitude
  coarser than SSURGO. It says of itself: "Considering the scale, the precision of the variables is
  weak. Furthermore these variables were estimated over large areas by expert judgement rather than
  measured on local soil samples." Its terms: "**under no circumstances are these data passed to third
  parties. Moreover they must not be used in any way for commercial gain.**"

<!-- vale off -->

- **LUCAS Topsoil** is the real measured survey: 19,967 samples in 2009, 21,859 in 2015, 18,984 in
  2018, and 31,054 in 2022 (public release pending). Its license grants "a **personal, non transferable**,
  perpetual, and non exclusive right … **No sub-licence is allowed**", accessible "only to the Licensee
  and staff working for the Licensee's Organization", with map display permitted only "as far as the
  geographical location of the soil samples is not detectable". It has roughly one point per
  150–250 km², so it is a point set rather than a surface.

<!-- vale on -->

- **The 500 m property maps are models** rather than surveys. They are MARS and Gaussian-process
  regressions fitted to LUCAS 2009, with per-property fit disclosed down to "CEC (R2= 0.35)". They carry
  the same no-third-parties clause, while permitting commercial use.
- The nearest products to a capability rating are **Soil Biomass Productivity** (1 km, a unitless 0–10
  index) and **Land suitability in temperate Europe** (250 m, 14 crops), which covers only "38.2% of
  the EU territory". Both carry the no-third-parties clause. The ESDB's `AGLIM1` is "Code of the most
  important limitation to agricultural use", a limitation code rather than a graded class.

<!-- vale off -->

**The permissive route to LUCAS does not carry the soil measurements.** Eurostat publishes LUCAS survey
microdata for 2006–2022 with anonymous per-country CSV downloads under terms that authorise reuse
"provided the source is acknowledged", with "no special procedure or requirement for a written licence".
Eurostat, however, states: "Soil data — The datasets for the LUCAS topsoil module are available
from the European soil data centre (ESDAC)." The files confirm it. The 2022 (306 columns) and 2018 (97
columns) country CSVs carry soil _sampling metadata only_, without pH, organic carbon, N/P/K, or texture.
**The open route yields coordinates, land cover and a join key, and nothing about what is in the soil.**

<!-- vale on -->

One contradiction remains open and is reported rather than resolved. data.europa.eu labels "LUCAS 2018
TOPSOIL data" **CC BY 4.0**, while the record's only distribution link points back at the ESDAC page
carrying the restrictive terms above. The European Commission's legal notice resolves the hierarchy in
ESDAC's favour: "**Unless otherwise indicated** (e.g. in individual copyright notices), content owned by
the EU … is licensed under … CC BY 4.0". A per-dataset Notification is such an individual notice. This
is our interpretation (§8), and no authority states it for this dataset. Do not rely on the portal
label.

**EEA** publishes no independent pan-EU soil-capability layer. Its soil holdings are hosted JRC/ESDAC
copies (carrying ESDAC's terms rather than CC BY), hosted CLMS products, and a handful of EEA-original
soil-themed 1 km layers (soil-biodiversity potential, heavy metals and nutrients in agricultural soils,
soil-moisture deficit), which do carry "License CC-BY 4.0 … Copyright holder: European Environment
Agency (EEA)". None is a capability product.

**The global fallback tier** was verified only for license, resolution and access, because this record
uses it only for those. **SoilGrids 250 m v2.0** (ISRIC) is **CC BY 4.0** with anonymous WCS/WMS and WebDAV
bulk download, but it is explicitly a machine-learning prediction from the WoSIS profile database rather than a
survey. **GAEZ v5** (FAO/IIASA, launched April 2025) publishes crop suitability as a 0–10,000 index at
30 arc-seconds for more than 70 crops under rain-fed and irrigated conditions, **CC BY 4.0**, anonymous
download. **HWSD v2.0/v2.01** (FAO/IIASA, 30 arc-second) is the exception: it is **CC BY-NC-SA 4.0**,
and "No part of this Harmonized World Soil Database may be reproduced … for resale or other commercial
purposes without written permission". That rules out any use this program would make of it. One
inconsistency is noted and not reconciled: GAEZ v5 is derived from HWSD v2, yet it is published CC BY 4.0.

**The consequence for this program.** A published European arability layer has two options. It can be
derived from CLMS land-cover and cropland products plus open global soil models, with the Regulation's
attribution conditions carried in the manifest. That yields cover and modelled properties rather than a
survey's capability rating. Alternatively, it can be built on ESDAC data and **never redistributed**,
because the third-party clauses forbid shipping it. Neither is the same product as the US pilot, and
neither should be presented as one. Europe offers no shortcut, the same conclusion the flood survey
reached by a different route.

### 2.4 Deliberately not surveyed

- **State and county soil or farmland-protection layers.** Several US states publish their own
  important-farmland mapping under their own terms. None was verified and none is claimed. 7 CFR
  657.5(c) makes clear that the state criteria differ by design, so pooling them would pool incompatible
  vocabularies.
- **Modeled suitability products that are not a survey.** The issue puts authored land-use judgment out
  of scope, and this record keeps it out. The layer's value is that it repeats an authority. A modeled
  suitability score would be a different product with different obligations.
- **Crop-yield and productivity statistics.** NASS publishes county-level yield series. Those are
  statistics about production rather than statements about a location, and they do not key to the
  spine.

### 2.5 The inventory, side by side

|                         | **NRCS — SSURGO (+ Soil Data Access)**                                                   | **NASS — Cropland Data Layer**                                   | **EU level**                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| authority               | USDA Natural Resources Conservation Service                                              | USDA National Agricultural Statistics Service                    | none for soil — CLMS for cover, JRC/ESDAC for soil                                        |
| what it is              | a field soil survey — land **capability**                                                | a classified satellite raster — observed **cover in one season** | land cover (open) and soil models (restricted); **no capability survey**                  |
| license                 | **"This is public information"** in the shipped FGDC metadata; acknowledgement requested | **CC0 1.0**, and the link resolves to the real deed              | CLMS: **Reg. (EU) 1159/2013** rather than CC BY. ESDAC: "**not passed to third parties**" |
| extent                  | 3,380 survey areas, 61 state/territory prefixes; actual gaps (§3.2)                      | 18 CONUS years, 2008–2025                                        | EEA39 for CLC; EU for ESDAC                                                               |
| vocabulary              | LCC 1–8 + subclass c/e/s/w; 23 Farmland Classification values, **conditional**           | crop classes per pixel (class table unverified, §8)              | CLC 44 classes, arable = 211/212/213; no capability vocabulary anywhere                   |
| resolution / scale      | source scales 1:12,000–1:15,840; median delineation 24,863 m² (§4.4)                     | 30 m pixels                                                      | CLC **25 ha** minimum unit; ESDB **1:1,000,000**; property maps 500 m models              |
| vintage                 | refresh 2025 for 3,323 of 3,380 areas; **field survey far older — 1960 for `IA153`**     | one file per season; 2025 current                                | CLC2018 current; **CLC2024 scheduled rather than published**                              |
| cadence                 | one coordinated annual refresh; metadata says `As needed`                                | annual, published the following calendar year                    | CLC roughly six-yearly; ESDAC ad hoc                                                      |
| format                  | shapefile + pipe-delimited tabular, **WGS84**; `IA153` = 25.5 MB / 27.6 MB               | 30 m raster zip; 2025 = 1.89 GB (measured)                       | CLC raster/vector EPSG:3035; ESDAC per-request archives                                   |
| acquisition             | WSS download service (date from SDA) **+ live SQL and spatial SDA**                      | direct file URL on `www.nass.usda.gov`                           | CLMS **EU Login + request-and-poll**; ESDAC **request form**                              |
| `HEAD` / `Range`        | `HEAD` 405, **`Range` ignored** — full transfer                                          | **`Range` honoured** (HTTP 206)                                  | not applicable — both require an account                                                  |
| reachable from this lab | **yes** — every distribution host answered; SDA measured at 0.374 s                      | **bulk yes**; CropScape API answers on `:8080` and **fails 500** | yes, but anonymous download refused **HTTP 401** by design (Art. 18(1))                   |
| in-repo ingest path     | vector — `ogr2ogr` already used here                                                     | **raster — no raster tooling exists in this repository**         | mixed                                                                                     |
| usable for this layer   | **yes — the pilot**                                                                      | yes later, as a different observation with a different meaning   | **no** — the open half has no soil, the soil half may not be redistributed                |

## 3. Coverage honesty per source

This section prevents the failure #1964 fixed for POIs: an unmapped area read as a surveyed one. For
soils the failure takes a particular form, because **the source distinguishes at least four kinds of "no
rating", and three of them do not mean "unsuitable"**. The one that _does_ mean unsuitable, capability
class 8, is a positive determination that a naive builder would merge with the others.

### 3.1 The claim a coverage row is allowed to make

`CoverageBasis.Designated` means "An authority declares the set complete for this cell". Inside a
published survey area, NRCS declares **its own soil mapping at its own scale** complete, which is not a
site-specific determination. The strongest claim this layer can support is therefore:

> the soil survey assigns this capability class to the map unit covering this location

and never

> this land can (or cannot) be farmed.

NRCS says the second reading is wrong, in the metadata it ships with every survey area: the data "do
not eliminate the need for onsite sampling, testing, and detailed study of specific sites for intensive
uses. Thus, these data and their interpretations are intended for planning purposes only." The
Environment Agency imposes the same constraint on flood zones: the map is authoritative about an area
and explicitly declines to be authoritative about a point. The pilot resolves addresses, so the
constraint applies directly, and the observation's wording must carry it as well as this document.

The enlargement caveat makes it stricter: "If enlarged, maps do not show the small areas of contrasting
soils that could have been shown at a larger scale." §4.4 measures how much contrast is hidden.

### 3.2 SSURGO — four absences, and only one of them is coverage

1. **Outside any published survey area — no data.** SSURGO is distributed per survey area, and 3,380
   exist. Land outside them has no map unit at all. Alaska is the large case (137 survey areas for the
   largest state). **A cell here gets no `layer_coverage` row.**
2. **Inside a survey area but not digitized — `NOTCOM`.** Measured: 37 map units carry the symbol
   `NOTCOM` with the name `No Digital Data Available`. The polygon exists, but the soil mapping behind
   it does not.
3. **Inside a survey area but not surveyed — access.** Measured: 72 map units named
   `Area not surveyed, access denied`, plus 7 with symbol `NOTPUB` / `Not Public Information`. NRCS
   models these as real polygons rather than as holes. FEMA uses the same wall-to-wall approach, and it
   makes these separable from case 1.
4. **Surveyed, mapped, and deliberately not rated.** This is the largest and least obvious case.
   `nirrcapcl` is NULL on **220,013 of 1,288,808 components (17.1%)**, and the NULLs have several
   meanings. Broken down by `compkind`:

   | `compkind`         | components | NULL `nirrcapcl` | what the NULL means                    |
   | ------------------ | ---------: | ---------------: | -------------------------------------- |
   | Series             |  1,016,587 |          101,611 | a real named soil that was not rated   |
   | Miscellaneous area |     79,494 |           25,849 | rock outcrop, water — **not rateable** |
   | (NULL `compkind`)  |     72,091 |           71,773 | the component itself is unclassified   |
   | Taxon above family |     46,308 |           13,093 | rated at a coarser taxon               |
   | Family             |     37,231 |            5,432 |                                        |
   | Taxadjunct         |     33,166 |            2,022 |                                        |
   | Variant            |      3,931 |              233 |                                        |

   **None of these is capability class 8.** Class 8 is a determination: the survey rated the land as
   precluding commercial plant production, and 67,547 components carry it. A builder that merged
   `NOTCOM`, `access denied`, a not-rateable water body and an unrated series into "not arable" would
   produce a well-formed wrong answer of the kind this repository keeps recording: four different
   absences and one positive negative finding, collapsed into one reassuring number.

   The irrigated rating shows the same problem at larger scale. `irrcapcl` is NULL on **1,097,370
   components (85.1%)**, because it is populated only where irrigation is a considered use. Read as
   "not irrigable", it would be wrong 85% of the time.

**The basis this supports:** `designated`, `completeness = 1.0`, for cells inside a published survey
area whose map units are digitized, because NRCS declares its mapping complete for those areas at its
own scale. Cells outside a survey area get **no row at all**, and `NOTCOM` and access-denied map units
get no row either. The layer's identity carries the class boundary, as `absence-route.ts` requires. That
module refuses to answer unless the layer holds exactly one class and the answered category is that
class, because "a coverage table carries a completeness per cell and no class". Here the held class is **the
nonirrigated Land Capability Classification from SSURGO**, one rating vocabulary from one authority,
and a reader must refuse to answer an irrigated-capability or a crop-presence question from it.

**The coverage row cannot express two limits.** Both come from NRCS's own text, and both are recorded
here rather than inferred:

1. **Non-uniform survey vintage inside one uniform refresh.** 3,323 of 3,380 survey areas carry a 2025
   version date, while the field survey behind them may be decades older (1960 for `IA153`). This limits
   currency rather than coverage: those areas are mapped, but from an old survey. The manifest's single
   `source_vintage` is the refresh. Each area's metadata carries its survey source date, and the layer
   should carry it per area rather than imply one national vintage.
2. **The scale the map may be read at.** The metadata's enlargement caveat limits the consumer rather
   than the data, and no column expresses it. §4.4 turns it into a measured number, which is the only
   form a builder can act on.

### 3.3 The Cropland Data Layer — a different question, and its zero means something else

The CDL's absences are not coverage absences at all. A cell classified as anything other than a crop is
a positive classification of that season's observed cover. "Not cropped in 2025" makes no statement about
capability, because the field may be fallow, in pasture, in a rotation year, or misclassified. The layer
would answer a different question from SSURGO, so it cannot share SSURGO's coverage rows or vocabulary.
§4 keeps them as separate observations rather than blending them into one arability number. NASS's own per-class accuracy statements and use caveats were not verified here (§8), and a
builder must read them before the CDL becomes an observation of anything.

**The derived Crop Frequency Layer carries a meaning-of-zero inversion that would be easy to ship.**
From its FGDC metadata (`metadata_Crop-Frequency-Layers-2025_FGDC-STD-001-1998.htm`), the value domain
runs `"1" Planted 1 time in 18 years` … `"18" Planted 18 times in 18 years`, and then
**`"255" Planted 0 times in 18 years`**, while **`"0"` is No Data / Background**. A reader that takes 0
as "never planted" gets the answer backwards: it reads _we have no data here_ as _nothing was ever grown
here_. This repository's meaning-of-zero rule exists to prevent that failure, and here the source's own
encoding builds it in. Whoever ingests that product must map 255 and 0 before anything else.

## 4. One acquisition, two consumers — the schema answer

The issue asked for this section, and it is the one place this survey goes beyond the flood survey's
structure. The flood layer had one consumer. This layer has two, and they need different things from the
same bytes.

### 4.1 The two consumers, and what each needs

**Consumer A — the result-level observation.** A caller geocodes an address. After the resolver has a
coordinate, the layer answers "what does the soil survey assign here". This consumer needs **one reading
with its provenance**: the class, the authority, the vintage, and enough for the caller to re-derive the
claim. The observation is additive and off by default, and `QueryIntentMarker` carries it exactly as it
carries the flood observation.

**Consumer B — #1683's per-cell activity-affordance vector.** It needs arability **as one axis beside
light, dwellings, amenity density and the rest**, at a fixed cell grain, for every cell, with "no signal
here" distinguishable from "signal says no". It never asks about one address. It reads a whole cell
population and fits against it. #1684 experiment 2 is the precedent: a regularity fitted across cells
and held out geographically.

The two needs look different, but **if the layer stores a distribution rather than a winner, both read
the same object.** A winner satisfies A and fails B, because a single top class has no magnitude for the
signal to vary over and no way to say "mixed". A raw polygon table satisfies neither without a runtime
spatial query. A per-cell distribution over the authority's own vocabulary serves both: A takes the top
entry with its share, and B takes the whole vector.

### 4.2 The vocabulary is the authority's, verbatim

The layer stores the code NRCS published, in NRCS's spelling, with NRCS's date. It adds neither an
arability score, a 0–100 suitability, nor a cross-country scale. Capability class `"1"`–`"8"` and subclass
`c`/`e`/`s`/`w` are stored as published. `farmlndcl` is stored as the full conditional string, because
`Prime farmland if drained` is a different statement from `All areas are prime farmland`, and dropping
the condition would invent a determination nobody made. NCCPI is stored as its own index in [0, 1] under
its own rule name and is never blended with the capability class.

The builder holds the authority's declared domain as a closed set and **throws** on a value outside it.
An unknown code means the source schema changed, which a reader most needs to know. Coercing it to a
nearest neighbour or to NULL would turn "the source changed" into "there is no observation here".

This matters more for Consumer B than it first appears. #1683's vector needs a numeric axis, so storing
one is tempting. Instead, **the consumer owns the projection to a number, and the layer stores none**. The layer
stores class shares, and the signal consumer chooses the projection its fit needs. The layer then stays
correct if the projection changes later, and the observation consumer reads the authority's values
rather than our arithmetic.

### 4.3 Which shape each source takes

This layer stack has two settled storage shapes, and **the source's own geometry decides which one
applies, regardless of the layer's subject.** This section first states the shape per source.

| source                                         | geometry                     | shape that applies                                                                                     |
| ---------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| **SSURGO map units — the pilot**               | vector polygons              | **the polygon rule** (#1989): unsimplified geometry as truth, an H3 `whole`/`partial` summary above it |
| **gSSURGO / gNATSGO** (the raster derivatives) | 10 m state / 30 m CONUS grid | **the raster rule**: never raster-in-database — per-cell class summaries at the signal resolution      |
| **Cropland Data Layer**                        | 30 m grid                    | **the raster rule**, same as above                                                                     |

**The polygon rule, for the pilot.** SSURGO ships vector polygons, so the delineation geometry is the
truth. It is stored unsimplified with a precomputed bounding box, as the flood layer stores its rings.
Above it sits an H3 containment index that records `whole` or `partial` per cell, with `compactCells`
collapsing uniform interiors. The resolution is chosen from the **measured** `partial` share rather than
by argument. The index alone answers a cell that lies wholly inside one map unit. A cell that a boundary
crosses lists every map unit reaching into it, and a ray-cast against those few candidates is the
bounded runtime geometry that SCOPE invariant 6 permits at an irreducibly geometric edge.
`pointInPolygonRings` and `bboxAround` in `@mailwoman/spatial` are the primitives, so no new primitive is
needed.

**The raster rule, for anything grid-shaped.** A raster never enters the database as a raster. At build
time it is binned into per-cell class summaries at the signal resolution (a top class with its fraction,
or a small class histogram), with the minority-class loss stated. That is the entire size strategy for
those sources. It turns national 30 m grids from gigabytes into a per-cell table, and #1683's vector
consumer already wants that shape, so one aggregation serves both consumers.

**Under both shapes, absence means no row.** A cell with no survey behind it gets no `layer_coverage` row
and no summary row, never a zero or an empty histogram. For a sparse layer this is also the size
strategy, and §4.5's meaning-of-zero rule makes it safe.

**Where the two shapes converge, which is why this layer needs both.** With the polygon rule alone,
Consumer B, which reads whole cell populations in bulk, would ray-cast every cell on every read. The
pilot therefore carries the containment index **and** a per-cell summary derived from it, which is the
same object the raster rule produces. The summary is neither a second acquisition nor a second
aggregation. It is the polygon index reduced once at build time, and §4.4 describes the reduction.

### 4.4 The aggregation choice, and the information it discards

**The choice: store the area-weighted distribution over capability classes per cell, plus an explicit
share for each kind of non-rating. Do not store a winner.**

Three measurements require this choice, and each was measured rather than reasoned.

**First, the source is already a mixture before we aggregate anything.** Components per map unit,
measured over all 339,191 map units:

| components in the map unit | map units | share      |
| -------------------------- | --------: | ---------- |
| 1                          |    54,414 | **16.0 %** |
| 2 or more                  |   284,777 | **84.0 %** |

The maximum is 26. By `mukind`, there are 210,339 Consociation, 94,803 Complex, 25,926 Association and
7,770 Undifferentiated group map units, so **128,499 map units (38.0 %) are not consociations at all.** A
complex is NRCS's statement that two or more soils are intermingled and _cannot be separated at the
mapping scale_. The mixture is the survey's own finding rather than a loss we introduced.

**Second, in one map unit in six the largest component covers a minority of it.** Bucketing each map unit by its maximum
`comppct_r`:

| dominant component covers | map units | share  |
| ------------------------- | --------: | ------ |
| ≥ 85 %                    |   177,253 | 52.3 % |
| 70–84 %                   |    41,508 | 12.2 % |
| 50–69 %                   |    63,377 | 18.7 % |
| 35–49 %                   |    47,113 | 13.9 % |
| < 35 %                    |     9,940 | 2.9 %  |

**In 57,053 map units (16.8 %) the largest component covers less than half of the unit.** In one case
out of six, "take the dominant component" makes a claim about a minority of the ground.

**Third, every affordable cell size leaves the mixture in place, and this measurement settles the
resolution question.** The real `IA153` shapefile has 17,966 map-unit delineations covering 1,532.5 km². After
reprojection to EPSG:5070 and measurement with `ogr2ogr`, the median delineation is **24,863 m²** and
the mean is 85,302 m². Against H3's average cell areas:

| H3 resolution | average cell area | delineations smaller than one cell |
| ------------- | ----------------: | ---------------------------------- |
| 7             |      5,161,293 m² | 17,952 / 17,966 = **99.9 %**       |
| 8             |        737,328 m² | 17,705 / 17,966 = **98.5 %**       |
| 9             |        105,333 m² | 15,350 / 17,966 = **85.4 %**       |
| 10            |         15,048 m² | 6,052 / 17,966 = **33.7 %**        |
| 11            |          2,150 m² | 371 / 17,966 = **2.1 %**           |

At res 9, the resolution `poi.db` keys its rows at, **85 % of soil delineations are smaller than one
cell**, so the typical cell straddles several. Res 11 would nearly remove the mixture, at roughly 49×
the cells of res 9. A CONUS res-9 index is already about 77 million cells by simple arithmetic
(8,080,464 km² divided by the res-9 average area), against about 11 million at res 8 and 1.6 million at
res 7. A finer resolution cannot affordably remove the mixture. **It is a property of the data, and the
schema must report it rather than hide it.**

**NRCS itself already handles the mixture this way, which is the strongest argument for it.** The
`muaggatt` table carries `niccdcd`, the capability class by dominant condition, **beside `niccdcdpct`,
the share of the map unit that class covers.** Measured over all 339,191 rows:

| `niccdcdpct` |  map units | share     |
| ------------ | ---------: | --------- |
| ≥ 85 %       |    242,592 | 71.5 %    |
| 70–84 %      |     45,327 | 13.4 %    |
| 50–69 %      |     40,033 | 11.8 %    |
| **< 50 %**   | **11,239** | **3.3 %** |

The observed **minimum is 2 %**. The authority ships its own aggregation together with the share that
supports it. The layer reproduces that pattern at cell grain rather than inventing a new one.

**Information discarded by this choice.** The choice loses three kinds of information:

1. **Sub-cell spatial arrangement is lost.** After aggregation the layer knows that 40 % of a cell is
   class 2 and 60 % is class 6, but not _where_ within the cell. A caller whose coordinate falls in the
   class-6 part gets the cell's distribution rather than that part's class. NRCS's enlargement caveat
   warns about this loss, and it is why §3.1 forbids a point-level determination.
2. **Component arrangement inside a map unit was already lost in the source.** In a complex the survey
   did not record where each component lies, so no aggregation of ours could preserve it. Our area
   weighting therefore mixes two different things: polygon geometry, which we know, and component
   percentages, which are proportions without a location. **The layer must record which
   weighting produced each share**, because "60 % of this cell's area lies in map units whose dominant
   component is class 2" and "the components in this cell sum to 60 % class 2" are different claims.
3. **Minority classes survive as shares but lose their identity below a floor.** A class occupying 0.4 %
   of a cell is real but is noise for most consumers. Truncating a long tail is legitimate, but only if
   the truncation is recorded. The layer stores every class share above a declared floor and **one
   explicit `other` share** carrying the truncated remainder. The shares therefore always sum to 1, and
   a reader can see how much was folded away rather than inferring it from a gap.

### 4.5 "No signal here" versus "signal says no", carried structurally

#1683 states the requirement, and §3.2 shows that this source offers at least four ways to violate it.
The schema keeps the two cases apart by **never representing an absence with a small number**. Alongside
the class shares, each cell carries four separate shares that record why the rest of the cell has no
class:

| share               | meaning                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| `unrated_share`     | mapped soil components with a NULL rating — the survey did not rate them     |
| `notrateable_share` | miscellaneous areas (rock outcrop, water) the rating does not apply to       |
| `nodata_share`      | `NOTCOM` and access-denied map units — a mapped polygon without soil mapping |
| `other_share`       | the truncated minority tail from §4.4, loss 3                                |

Class 8 is **not** among them. It is a class share like any other, because it is a determination.
Together with the absent-row rule for land outside a survey area, that gives a reader five
distinguishable answers where a single number would give one: _the survey rated this land unsuitable_
(class 8 share), _the survey did not rate it_ (`unrated_share`), _the rating does not apply_
(`notrateable_share`), _the polygon exists but the mapping does not_ (`nodata_share`), and _there is no
survey here at all_ (no `layer_coverage` row, per the meaning-of-zero rule). A consumer that wants them
collapsed may collapse them. A consumer that reads a collapsed value cannot recover them, so the layer
stores them apart.

The `layer_coverage` row and these shares answer different questions, and both are needed.
`supportsExclusion(cell)` licenses only the claim that NRCS made a determination somewhere in the cell.
**The class distribution records what the determination says.** A cell that is 100 % `unrated_share` is
`designated`-complete and carries no capability reading at all. That pairing matches the flood survey's
Zone D trap: a cell that is complete and holds a determination that no determination was made. Here it
is not a corner case: **17.1 % of components carry no capability rating**, and for the
irrigated rating the figure is 85.1 %. The frequency in FEMA's data was not measured, so no ratio between
the two is claimed.

### 4.6 Tables

The layer has six domain tables plus the two interface tables, written as Kysely schema modules with the
typed interface co-located with its `createXTable`, per the house database conventions. The pilot is
polygon-shaped, so §4.3's polygon rule governs: `soil_map_unit_area` is the truth, `soil_map_unit_cell`
is the containment summary above it, and `soil_capability_cell` is the reduction both consumers read.

```
soil_map_unit_area         -- THE TRUTH: one row per delineation polygon, plain rowid (it holds a blob)
  area_id          TEXT PRIMARY KEY
  mukey            TEXT      -- the map unit this delineation belongs to
  areasymbol       TEXT
  min_lat, min_lon, max_lat, max_lon  REAL   -- precomputed bbox, the ray-cast prefilter
  rings            BLOB      -- the authority's ring coordinates, UNSIMPLIFIED
                             -- 17,966 delineations for IA153 alone; median 24,863 m² (§4.4)

soil_map_unit_cell         -- the build-time containment index, WITHOUT ROWID
  h3_cell          INTEGER   -- 48-bit short cell at the declared resolution
  area_id          TEXT
  containment      TEXT      -- 'whole' | 'partial'
  PRIMARY KEY (h3_cell, area_id)
                             -- compactCells collapses uniform interiors; see §4.7 for why the
                             -- compaction yield here is far below the flood layer's

soil_map_unit              -- one row per SSURGO map unit, plain rowid table
  mukey            TEXT PRIMARY KEY   -- NRCS's own key
  areasymbol       TEXT      -- the survey area, e.g. 'IA153'
  musym            TEXT      -- the map unit symbol; 'NOTCOM' / 'NOTPUB' are meaningful values
  muname           TEXT
  mukind           TEXT      -- Consociation | Complex | Association | Undifferentiated group
  farmlndcl        TEXT?     -- the full conditional string, verbatim; NULL is not 'not prime'
  niccdcd          TEXT?     -- NRCS's own dominant-condition capability class
  niccdcdpct       INTEGER?  -- and the share it rests on — carried, never recomputed over it
  nccpi_v3         REAL?     -- the NCCPI v3.0 index in [0,1], under its own rule name

soil_component             -- the map unit's components, because the map unit is a mixture
  cokey            TEXT PRIMARY KEY
  mukey            TEXT
  comppct_r        INTEGER   -- the weight §4.4 aggregates by
  compkind         TEXT?     -- 'Miscellaneous area' is what separates not-rateable from unrated
  nirrcapcl        TEXT?     -- '1'..'8'; NULL means NOT RATED, never class 8
  nirrcapscl       TEXT?     -- 'c' | 'e' | 's' | 'w'
  irrcapcl         TEXT?     -- NULL on 85.1% of components; absence is about applicability

soil_capability_cell       -- THE SHARED ARTIFACT BOTH CONSUMERS READ, WITHOUT ROWID
  h3_cell          INTEGER   -- 48-bit short cell at the declared resolution
  class_shares     TEXT      -- JSON: the authority's class codes -> area-weighted share
  unrated_share    REAL      -- §4.5, each stored apart; the five never collapse into one number
  notrateable_share REAL
  nodata_share     REAL
  other_share      REAL      -- the declared truncation floor's remainder
  top_class        TEXT?     -- consumer A's reading: the largest class share
  top_class_share  REAL?     -- and the share it rests on, NRCS's own pattern at cell grain
  weighting        TEXT      -- which weighting produced the shares (§4.4 loss 2)
  PRIMARY KEY (h3_cell)

soil_survey_area           -- the authority's mapped footprint rather than the union of rated polygons
  areasymbol       TEXT PRIMARY KEY
  areaname         TEXT
  saverest         TEXT      -- the refresh date — the manifest's vintage
  survey_source_date TEXT?   -- the FIELD survey date from the area's own metadata (1960 for IA153)
  source_scale     INTEGER?  -- 15840 for IA153's original survey

layer_manifest / layer_coverage   -- the interface tables, from @mailwoman/core/layers
```

`WITHOUT ROWID` on `soil_map_unit_cell` and `soil_capability_cell` and not on `soil_map_unit_area`
follows the interface's own guidance. Small fixed-width rows probed by their exact primary key belong in
the B-tree, and a row carrying a geometry blob does not.

**The three cell-facing tables are one pipeline rather than three sources.** `soil_map_unit_area` holds
what the authority drew. `soil_map_unit_cell` records which cells each delineation reaches and whether
it fills them. `soil_capability_cell` is that index reduced once, at build time, into the per-cell
distribution. A `partial` cell's contribution to the reduction is weighted by the area it covers. The
truth table must therefore keep unsimplified rings, because simplifying them would change the weights
without any error, and both consumers read the reduction.

`soil_survey_area` is a separate table for the same reason the flood survey gives `flood_map_extent`
one. Deriving the mapped footprint from the rated polygons would make exactly the error §3.2 describes,
because `NOTCOM` and access-denied map units are inside the footprint and carry no rating. The table
also carries the two dates that §3.2 requires be kept apart.

**`soil_capability_cell` answers the issue's question.** Consumer A reads `top_class` and
`top_class_share` for the cell containing the resolved coordinate, and reports both. Consumer B reads
`class_shares` plus the four absence shares as its axis. There is one artifact, one aggregation, and
one set of provenance rows, so the two consumers cannot disagree about the ground. Two separate
acquisitions would guarantee that disagreement.

### 4.7 Manifest fields, and the resolution the pilot measures

| field                       | pilot value                                                                       |
| --------------------------- | --------------------------------------------------------------------------------- |
| `name`                      | `soil-capability-nrcs-ssurgo-ia`                                                  |
| `version`                   | the SSURGO refresh the build ingested                                             |
| `tier`                      | `shipped` — the shipped FGDC metadata states "This is public information"         |
| `license`                   | the public-domain identifier, with the metadata quotation recorded in the builder |
| `attribution`               | "U.S. Department of Agriculture, Natural Resources Conservation Service"          |
| `source` / `source_vintage` | the survey-area set and its `sacatalog.saverest` refresh date                     |
| `build_cmd` / `build_sha`   | the invocation and the commit that produced it                                    |
| `freshness_policy`          | `versioned-refresh` — NRCS re-issues annually under the same product              |
| `spine_keys`                | `{ h3: { column: "h3_cell", resolution: … } }` — see below and §1                 |
| `created_at`                | caller-supplied, per the interface                                                |

**The pilot measures the resolution, and §4.4 has already bounded it. Run the `partial`-share
measurement at res 7, 8, 9 and 10**, four candidates, on the pilot region, over the real delineations.
Res 11 is listed only to exclude it: it would leave 2.1 % of delineations sub-cell and costs roughly 49×
res 9, which is out of reach at national scale. Report two numbers at each candidate, because they
answer different questions:

1. **The `partial` cell share**: the fraction of cells a delineation boundary crosses. This is the
   #1989 number. It decides whether the containment index answers most probes alone or whether the
   ray-cast is the common path.
2. **The share of cells whose top class holds less than half the cell**: the cell-grain analogue of the
   `niccdcdpct` distribution in §4.4. It decides whether the layer gives a clear answer or a split one,
   and Consumer B's fit will depend on it.

**Expect the `partial` share to be the reverse of the flood layer's, and design for that.** The flood
layer's polygons are large relative to its cells, so most cells fall wholly inside one zone and
`compactCells` collapses long uniform interiors. Soil delineations are the opposite. On `IA153`,
**85.4 % of them are smaller than one res-9 cell** (§4.4). With small polygons and large cells, a
boundary crosses most cells. At res 9 the `partial` share should therefore be high, `compactCells` should
yield little, and the index alone will rarely answer a point probe. This does not argue against the
polygon rule. The unsimplified geometry is still the truth, and the ray-cast is still bounded to the
candidates one cell lists. It **does** explain why this layer carries the reduced `soil_capability_cell`
alongside the index instead of relying on the index as the flood layer can. A coarser resolution
improves the `partial` share and worsens the mixture. The two numbers above move in opposite directions,
and the measurement exists to choose between them.

The same measurement would decide a future raster layer's signal resolution, with one difference. A
raster has no `partial` cells to count, because a 30 m pixel either falls in a cell or does not. For the
raster rule the only number is the second one, the class-mixture share per cell.

Two known traps carry over from the flood survey and `build-poi.ts`, and comments in that code already
describe both: `polygonToCells` from h3-js takes `[lat, lng]` per vertex in its default mode, and a coverage
cell must be `cellToParent` of the finer cell rather than a direct `latLngToCell` at the coarse
resolution. The coverage resolution is derived from the stored cells rather than assumed.
`absence-route.ts` explains why, and it measured 290 of 290 cells expanding at resolution 6 and at no
other.

## 5. The pilot

### 5.1 The source: NRCS SSURGO, read through Soil Data Access

Five reasons support this choice, in order of weight.

1. **The acquisition path is reachable and was exercised end to end.** Every distribution host answered.
   SDA returned a tabular answer in 0.374 s and a point-intersection answer in 1.807 s, and a real
   25.5 MB survey-area archive was downloaded and opened. The issue asked whether USDA hosts behave like
   FEMA's, and the measurements show they do not. The one host that stalls, `nassgeodata.gmu.edu` (zero
   bytes in 30 s), belongs to the CDL rather than to the soil survey, and it is a university host rather
   than a federal one.
2. **The license is verified from the producing agency's own shipped metadata**, rather than from a
   catalog field that points at a page declining to grant anything. "This is public information", an
   acknowledgement request, and a liability clause contemplating distribution together give a `shipped`
   layer the license position it needs.
3. **It is a vector ingest, and this repository already does vector ingest.** SSURGO ships shapefiles in
   WGS84. The CDL ships a projected raster into a repository with no raster tooling in any
   `package.json` or in `yarn.lock`.
4. **It answers the capability question rather than the observed-cover question.** #1683 lists land
   arability, which describes what the land affords, and that is a soil survey's subject. What was
   planted last season is a different signal that would need its own coverage semantics.
5. **It tests the two-consumer design and the meaning-of-zero rule as hard as any source could, and that
   is intended.** The source has four distinct absences, 84 % of its map units are mixtures, and its own
   dominant-condition share drops to 2 %. A schema that handles SSURGO will handle the simpler layers.

The Cropland Data Layer stays in the inventory as the natural second layer. It is CC0, measured, and
answers a different question. It can follow once a raster path exists and its accuracy caveats are read.

### 5.2 The region

**Iowa, whole**, built survey area by survey area (99 areas). Iowa is the right size for a first build
and too small for a national claim, and that is intended: the manifest's declared extent and the
coverage rows describe the same set, which is the 99 published survey areas rather than "the United
States". Simple arithmetic against the H3 average areas gives roughly 1.38 million cells at res 9 and
198,000 at res 8, small enough to build repeatedly while the aggregation is tuned.

Iowa is also a hard case in a useful way. Prime farmland is dense there, so the capability classes are
well populated and the `farmlndcl` conditionals (especially "if drained") occur in practice rather than
only in principle. `IA153`, measured above at 17,966 delineations over 1,532.5 km² with a 1960 field
survey behind a 2025 refresh, is the smoke rung.

### 5.3 The verification ladder

**Fixtures.** Hand-built geometry and hand-built components, without network access.

On the polygon rule (§4.3), the fixtures cover:

- a cell wholly inside one delineation, asserting `containment = 'whole'` and that the probe resolves
  from the index **without** touching geometry;
- a cell a boundary crosses, asserting `containment = 'partial'`, that every delineation reaching into it
  is listed, and that the ray-cast runs only against those;
- a run of uniform interior cells, asserting that `compactCells` collapses them and that expansion
  round-trips;
- a delineation whose ring is deliberately re-ordered, asserting that the stored rings are
  byte-identical to the source rather than normalized.

On the reduction (§4.4/§4.5), the fixtures cover:

- a cell straddling two map units with known areas, asserting the shares are the area weighting and
  no other value;
- a `partial` cell, asserting its contribution is weighted by covered area rather than counted whole;
- a map unit whose components are 45/35/20 across three capability classes, asserting no winner is
  invented;
- a `NOTCOM` polygon, asserting `nodata_share` and **not** a low class;
- a miscellaneous area, asserting `notrateable_share`;
- a rated class-8 component, asserting it lands in `class_shares` and not in any absence share;
- a truncated minority tail, asserting the shares still sum to 1 and the remainder is in `other_share`;
- a point outside every survey area, asserting **no coverage row and no summary row** rather than a
  zero;
- an undeclared capability code, asserting a throw rather than a coercion.

**Smoke.** `IA153` alone, from the real archive. This verifies what fixtures cannot: the actual
shapefile field names, that `.prj` really is WGS84, that the pipe-delimited tabular export parses, that
`mukey` joins spatial to tabular, and the seal. The first live poi.db builds caught three bugs that 800+
green tests missed, all of them source-schema or scale behavior.

**Full.** All 99 Iowa survey areas, end to end, plus the two checks that only exist at full scale.
Memory must stay flat in row count, because the poi build ran out of heap at 13.68 M rows when a reader
materialized instead of streaming. The coverage insert must also be chunked. `writeLayerCoverage`
already batches at `COVERAGE_INSERT_BATCH`, and a builder that hand-rolls its own insert will hit
SQLite's 32,766 bound-variable ceiling again.

**An agreement check against a second path.** Re-query a sample of points from the built artifact
through SDA with `SDA_Get_Mukey_from_intersection_with_WktWgs84`, and report the agreement rate. The
authority is the same and the distribution channel differs, so the check tests our conversion rather
than the authority. At the measured 1.807 s per point, a few hundred points take minutes. The negative
half matters as much: a sample of points in a neighboring state with no artifact rows, confirming that
the layer returns **no coverage row** rather than a low capability reading.

That last check would catch the kind of defect §3 is about, and it is cheap.

### 5.4 The consumer shape

**Which paths may attach it.** Only the geocode path, after the resolver has produced a coordinate for
the node the caller asked about. The parse path has no coordinate to ask about.

**Off by default, and the presence of the layer path is the switch**, rather than a boolean. This is the
shape `poiSemanticLookup` settled on, because a boolean makes the factory construct the reader itself
and opens a layer on the default construction path. The flag and its row in the
[runtime-flag register](../../engineering/reference/runtime-flags.mdx) land in the same change.

**Ranking is unchanged, and byte-stability is the evidence.** The same query, with and without the layer
attached, returns an identical result plus one advisory. That follows from how the carrier is built: it
reads neither candidates, coordinates, nor ordering, and a test pins that.

**What the observation reports.** It reports the top capability class as published **with the share
that supports it**, the `farmlndcl` string verbatim including its condition, the survey area and both
its dates, the coverage cell with its basis, and the four absence shares. That is enough for a reader to
re-derive the claim instead of trusting it. The wording carries §3.1's constraint: it reports what the
soil survey assigns to the map unit covering the location, never whether the land can be farmed.

**Consumer B does not use this path at all.** #1683's vector reads `soil_capability_cell` directly, by
cell, in bulk. This is the benefit of the shared artifact: the observation path and the signal path
share only the data, so neither constrains the other's shape.

### 5.5 The carrier, and the one place it does not fit

`QueryIntentMarker` is the carrier, for the same reasons and with the same reservation the flood survey
records. Its interface already matches the requirement. It is additive and attributed, always
accompanies the ordinary answer, never changes which answer wins, carries `mechanism` in the
`family:rule` form, and has an `evidence` record where everything above goes.

It fails to fit in the same place as for the flood layer, so the two layers should resolve it together.
`QueryIntentMarker.kind` holds a query kind the verdict carries, and intent never raises a soil
observation. `declared_ambiguity` is the precedent for a marker raised at resolve time rather than by
the classifier, but that marker has a kind of its own, and this one would reuse the verdict's own top
kind. Either accept that in writing or widen the carrier. The choice is outside the scope of a survey.

## 6. The product requirement

A caller who geocodes an address inside a published soil survey receives, alongside the ordinary result
and without changing it, the survey's own land-capability reading for the resolved coordinate: the
capability class in the authority's vocabulary **together with the share of the cell that class covers**,
the farmland classification exactly as published including any condition attached to it, the survey area
with both its refresh date and its field-survey date, and the coverage record stating that the authority
made a determination there. Where the survey published no determination, the caller learns which case
applies: land outside any survey area, a polygon without digital soil mapping, an area where access was
denied, or a soil the survey chose not to rate. The caller never receives a number that reads like a
verdict. Land the survey rated as precluding cultivation is reported as that rating and is never
confused with land the survey did not rate. The observation states what the map assigns at a location
and never whether the land can be farmed, because the authority itself declines that second statement
and says so in the metadata it ships. #1683's affordance vector reads the same per-cell artifact,
unchanged and not duplicated, as its arability axis. Ranking, abstention and every existing result field
are unchanged. The observation is additive, attributed, and off by default.

## 7. The builder-issue outline

The builder issue is not filed here. This is the outline for the issue that lands against this survey:

**Shape.** Follow `bdc`: a workspace holds acquisition, parsing and the layer reader, and the CLI is thin
wiring. `gazetteer build bdc` takes `--state` as a FIPS code, which is the precedent for a region-scoped
build. The SSURGO equivalent takes a state or an explicit survey-area list, with a single `--area` for
the smoke rung.

**Registration.** A new workspace joins six registers, and only the first produces an error when it is
missing. They are the root `workspaces` array, the `.release-it.json` publish list (or a
sanctioned-absence entry with the reason as data), **both** root `tsconfig.json` reference entries, and
the `smoke-clean-install.ts` pack set. The full paragraph, including the **bless-package obligation for
a brand-new npm name**, is in the root `AGENTS.md`. Re-run the release-list arithmetic afterwards and confirm every absent name still has a
reason someone can state.

**Acquisition.** The `APIClient` rule applies where it draws its line. SDA queries and `sacatalog`
freshness reads are API requests and go through `APIClient`: small bodies, repeated calls, and a service
with a server-side timeout. The survey-area archives are file transfers and keep raw `fetch`, with a
comment saying so, as `osm/sdk/fetch.ts` and `tiger/sdk/download.ts` do. The client must handle two
behaviors. **SDA returns an OGC `ServiceExceptionReport` XML on failure, including on a timeout**, so a
JSON-only parser mis-reads it. The download host answers `HEAD` with 405 and ignores `Range`, so
freshness comes from `sacatalog.saverest` rather than from a length probe.

**Build — the polygon rule, because SSURGO is polygon-shaped (§4.3).** Ingest the shapefiles with
`ogr2ogr` (already a dependency of the TIGER path) and the pipe-delimited tabular export. Build
`soil_map_unit_area` with precomputed bounding boxes and **unsimplified** rings as the truth, plus
`soil_map_unit` and `soil_component` for the attributes. Polyfill each delineation to the candidate
resolutions and record `whole` or `partial` per cell in `soil_map_unit_cell`, running `compactCells`
over uniform interiors. Reduce that index once into `soil_capability_cell`: the per-cell area-weighted
class distribution plus the four absence shares of §4.5, weighting each `partial` cell by the area it
covers, and recording which weighting produced the shares. Derive `soil_survey_area` from the
survey-area outline and each area's own metadata rather than from the rated polygons. Write
`layer_coverage` at `basis = designated`, `completeness = 1.0` for cells inside a published, digitized
survey area and **no row** outside. Absence means no row, here and in every table. Write the manifest,
seal it 0444, and build-then-swap.

**Do not put a raster in the database**, here or in any successor. If a builder uses gSSURGO or gNATSGO
instead of the vector product, the raster rule of §4.3 applies: bin at build time to the same per-cell
class summary shape and store that, never the grid.

**Measure and report both resolution numbers at res 7, 8, 9 and 10** (§4.7): the `partial` cell share,
and the share of cells whose top class covers less than half the cell. Pick from the measurement, and
report the second beside NRCS's own `niccdcdpct` distribution so the two are comparable. Expect the
`partial` share to be high at the finer candidates and `compactCells` to yield little, because the
delineations are small relative to the cells, the opposite of the flood layer's geometry.

**Verify** on the fixtures → smoke → full ladder in §5.3, ending with the SDA agreement check and its
negative half.

**Wire** the observation per §5.4/§5.5, default off, with its runtime-flag register row, and a
byte-stability test with the layer absent.

**Settle in writing** the two questions §1 leaves open: the spine-key declaration for a polygon-derived
cell layer, and whether the advisory code extends the query-intent vocabulary or widens the carrier.
The flood layer shares both, and one answer should serve both layers.

**Do not** build the CDL in the same issue. It is a raster ingest into a repository without raster
tooling, it answers a different question, and its accuracy caveats (§8) are unread.

## 8. What could not be verified

These are recorded as gaps. None was filled in with a plausible guess.

**Environment, which affects how the rest of this section should be read.** **`catalog.data.gov`'s CKAN
API is gone, and its search does not answer.** `GET /api/3/action/package_search` and `/api/3/action/status_show`
both return HTTP 404 with `{"detail":{},"message":"Not Found"}`, and `/dataset?q=SSURGO` returns HTTP 301
to the site root, discarding the query. The site itself serves (HTTP 200), and **individual dataset
pages still work**. `/dataset/soil-survey-geographic-database-ssurgo` and `/dataset/cropland-data-layer`
both returned 200 and carry usable embedded JSON-LD, which is where §2's license fields came from. A
builder can therefore read a known slug but cannot discover one. The flood survey's data.gov method
still works, except for its search step.

**NRCS / SSURGO.**

- **gSSURGO and gNATSGO file sizes were not measured over HTTP.** Box returns HTTP 403 to anonymous
  programmatic download, so every size in §2.1 for those products is Box's own `itemSize` metadata and is
  labeled as such. Their shipped FGDC metadata was also not read, because it is inside the archive.
  **gSSURGO has no data.gov dataset page** (13 candidate slugs each returned 404), so its license rests on
  SSURGO's rather than on a statement of its own. Whether their terms differ from SSURGO's is therefore
  **unverified**.
- **Whether gSSURGO CONUS is one file or several.** The product page says it "has been split into
  smaller files", while the distribution folder holds a single 24.44 GB archive. This is reported rather
  than resolved.
- **The complete Box folder listings.** Pagination stopped at roughly 20 of about 50 state files.
- **The Geospatial Data Gateway's ordering mechanism.** The host answers HTTP 301 and was not exercised.
- **The SSURGO Portal's own page** timed out on six attempts. The Portal is verified only indirectly,
  through the Annual Soils Refresh document and the Portal user guide PDF.
- **A national SSURGO download volume.** Four survey areas were measured (13.5 MB to 41.1 MB), and this
  record offers no extrapolation to the full set.
- **A published figure for SDA's server-side query timeout, and any rate limit or quota.** A timeout was
  observed, but no documented value was found, and no request returned a rate-limit header.
- **A national count of unsurveyed area.** The four absence categories in §3.2 are verified and counted
  in map units (37 `NOTCOM`, 72 access-denied, 7 `NOTPUB`, 220,013 unrated components). **Map-unit
  counts are not areas**, however, and no NRCS statement giving unsurveyed extent as a share of the
  country was found. Alaska is identified as the large case from its survey-area count only. This is
  the coverage figure the record most needs and lacks.
- **Whether `sacatalog.saverest` is documented as the version-established date** rather than the survey
  date. §2.1 infers it from the contrast between a 2025 `saverest` and the 1960 source citation inside
  the same survey area's metadata. That evidence is strong, but the Data Dictionary's own definition of
  the column was not read.
- **The per-survey-area metadata was read for one area (`IA153`).** The license text is boilerplate
  repeated across SSURGO and is safe to generalize. The 1960 source date is specific to Polk County, and
  the national distribution of survey vintages was not measured.
- **The complete declared domain for `nirrcapcl` / `nirrcapscl` and the NRCS prose definitions of
  capability classes 1–8 and subclasses c/e/s/w.** The values present in the data were measured. The
  authority's own definition text, which §4.2 requires the layer to store, was not retrieved, and the
  builder must take it from the National Soil Survey Handbook.
- **The NCCPI rule's own definition and interpretation guidance.** Its rule names, row counts and
  observed range (0.001–0.991) are measured. What the index means and how NRCS says it may be used were
  not read.
- **The one-area difference between 3,379 and 3,380 survey areas** (§2.1). The Annual Soils Refresh
  document and SDA's `Non-MLRA Soil Survey Area` legend count agree at 3,379, and `sacatalog` and the
  availability map agree at 3,380. Both figures are reported with their sources rather than choosing
  one.
- **Whether the two hosts' differing STATSGO2 national files** (446,108,728 vs 445,366,221 bytes) differ
  in content or only in packaging. Only the byte counts were compared, and neither archive was opened.

**NASS / Cropland Data Layer.**

- **The class-value table, the projection, and the per-state per-crop accuracy assessments.** None was
  verified. The CDL's accuracy varies sharply between major crops and minor classes. NASS's own caveat
  against site-specific use, the counterpart of the SSURGO enlargement caveat that §3.1 relies on, **was
  not retrieved**. No CDL observation may ship before it is.
- **Whether the non-agricultural classes are NLCD-derived**, and NASS's own words on their reliability.
- **Whether prior-year CDL files are revised in place**, that is, whether today's 2015 file is
  byte-identical to the 2015 file as first published. This determines whether a vintage pin is
  meaningful.
- **CroplandCROS's REST surface.** The successor portal answers HTTP 200, but its API requires an ArcGIS
  token, and `/arcgis/rest/services?f=json` returned HTTP 404, so the service list could not be
  enumerated.
- **Any decommissioning statement for CropScape.** This absence was checked. The FAQ (last modified
  2026-05-06) mentions CropScape once, in the past tense, and no NASS page announcing retirement was
  found. §2.2 documents the service's failure mode in place of a statement.
- **A CDL mirror on a permissively hosted bulk store.** The AWS Open Data registry carries no CDL, and its
  only "cropland" entries are African cropland-extent datasets. Google Earth Engine carries a lagging copy
  (2024, 30 m only), and the Geospatial Data Gateway carries a UTM-reprojected copy.

**EU.**

- **Which license prevails for LUCAS 2018 topsoil**: data.europa.eu's CC BY 4.0 label or ESDAC's
  restrictive per-dataset terms. The European Commission legal notice's "unless otherwise indicated"
  carve-out points to ESDAC's terms, but **that is our interpretation, and no authority states it for
  this dataset.** It is recorded as a contradiction rather than resolved.
- **Whether a site-wide ESDAC data policy exists** under a URL we did not try. Eighteen candidate URLs
  each returned HTTP 404, the homepage carries no such link, and site search returns HTTP 403. The
  per-dataset finding is directly supported, because the Notification blocks differ between datasets.
  The absence of a site-wide page was checked at those URLs and is not proven in general.
- **ESDAC's request flow end to end.** The form fields and the binding-acceptance wording were read, but
  the form was not submitted, so what a granted request delivers is unconfirmed.
- **CLC2024's publication.** The catalogue says "scheduled for publication in Q3 2026", which is the
  current quarter, and the dataset is not in the catalogue.
- **HRL Croplands' class count.** The same dataset record says both 17 and 19 crop-type classes.
- **CLC2018's sensor lineage.** The dataset metadata lists Sentinel-1 and Sentinel-2. The technical
  guidelines list Sentinel-2 with Landsat-8 gap filling and never mention Sentinel-1. This is
  unreconciled.
- **CLCplus Backbone 2021 and 2023 accuracy figures.** Both catalogue records have `null`.
- **LUCAS 2022 topsoil availability.** Its page states "Registration is requested: No", "you will need
  to register", and a third-quarter-2026 public release, all at once, and it has no data link.
- **Why GAEZ v5 is CC BY 4.0 while the HWSD v2 it derives from is CC BY-NC-SA 4.0.** No reconciling
  document was found. This is flagged rather than inferred.
- **A whole-product DOI for SoilGrids 2.0.** Only per-layer DOIs and the method paper's DOI were found.
- **GAEZ v4's license and access.** The v4 portal renders only under JavaScript. Everything stated about
  GAEZ here is v5.
- **The EEA Datahub as a search surface.** It is a JavaScript application without a findable search
  endpoint, so the EEA census was run against the SDI GeoNetwork API instead.

**This repository.**

- **Whether the res-8/res-9 choice holds at national scale** is not settled, and this record cannot
  settle it. §4.4's delineation-size distribution is measured on **one county in Iowa**, which is dense
  prime farmland and is therefore finely delineated. A rangeland or forest county will have larger
  delineations and a different mixture share, so §4.7's measurement must be taken per region rather than
  assumed from `IA153`.
