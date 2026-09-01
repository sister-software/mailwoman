# Erosion risk as a spatial layer — source survey and what each source's resolution supports

Design record for #1985. A survey, not a builder: it settles which authorities publish erosion data we
could carry, what each one's own words permit and forbid, **what spatial claim each source's resolution
actually supports**, and whether any of them supports a layer at all. The issue named a valid negative
outcome, and this record delivers a split verdict: **one viable coastal pilot, and a recorded finding
that no surveyed source supports a soil-erosion layer.** Both are completions, and the second is not a
consolation — it is the answer to the question the issue asked first.

The consuming implementation already exists, so nothing below proposes new architecture. The layer contract
(`layer_manifest` / `layer_coverage` on the H3 spine) is specified in
[`../../engineering/reference/layer-contract.mdx`](../../engineering/reference/layer-contract.mdx); the
exclusion-grade coverage pilot
([`2026-08-27-exclusion-grade-coverage-pilot.md`](./2026-08-27-exclusion-grade-coverage-pilot.md)) is
the basis discipline; the flood survey
([`2026-08-27-flood-layer-survey.md`](./2026-08-27-flood-layer-survey.md)) is this record's structural
template and the source of its acquisition mechanics; the arability survey
([`2026-08-27-arability-layer-survey.md`](./2026-08-27-arability-layer-survey.md)) verified the USDA
soil path this record reuses; and `packages/mailwoman/lib/observations/absence-route.ts` plus its
`QueryIntentMarker` carrier deliver an additive, provenance-carrying advisory without touching ranking.

**Every external claim below carries its URL and the date it was read.** Measurements taken from this
lab are labeled as measurements and give the command's answer, not a summary of it. Where a fact could
not be established from a primary source it is in §8 as unverified, with what was tried. Nothing in §8
was filled in with a plausible reading.

**The issue's expectation was half right, and the half it got wrong is worth naming.** Erosion was
ordered third because its source landscape was thought weakest. For **soil** erosion that expectation
held and then some — the strongest candidate cannot even be joined to a location, by statute. For
**coastal** erosion in England it did not hold at all: the Environment Agency republished its national
product in 2024 with four bulk formats and three live services, and it is as carryable as the flood
product the first survey chose.

## 1. What this record settles, and what it deliberately does not

Settled here: the verified inventory (§2); **the resolution-supports-what statement per source (§3.2),
which is this survey's distinctive deliverable**; what each source's own coverage statement licenses a
`layer_coverage` row to say (§3.3–§3.5); which storage shape each source takes, including the third
shape the inherited size contract does not cover (§4.2); the pilot's source, region, verification ladder
and consumer shape (§5); the recorded negative finding for soil erosion (§5.6); and the product
requirement (§6).

Not settled here, and named so nobody reads silence as a decision:

- **The English coastal mapped footprint** (§3.3). The Environment Agency publishes erosion zones and no
  coverage statement equivalent to the flood product's "covers all of England". Until a footprint source
  is settled the layer writes `CoverageBasis.SourcePresent` and supports presence only. Two candidate
  footprint sources are named in §3.3 and neither was verified here.
- **The H3 resolution** the containment index is built at (§4.5 — a measurement the pilot takes, at
  candidates this record names, not a choice this record makes).
- **The spine-key declaration for a polygon-derived cell layer** — the same open question both sibling
  surveys left, and the same answer serves all three.
- **Whether the observation's advisory code extends the existing query-intent vocabulary or widens the
  carrier** (§5.5), likewise shared with both siblings.
- **The licence contradictions on the two EU shoreline products** (§2.8). Each is reported as a
  contradiction; resolving one is counsel work, not engineering work.

Out of scope by the issue and kept out: any ranking or abstention change, and any erosion modeling of
our own. The layer records what an authority states, in the authority's vocabulary, with the authority's
dates and the authority's scenario. It computes no rate and no score.

## 2. Source inventory

### 2.1 The division this survey has to make before anything else

"Erosion" names two physically distinct subjects that share a word and share no unit, no authority, no
geometry and no consumer question:

- **Coastal erosion** — the retreat of a shoreline. Measured in metres of horizontal displacement,
  published by coastal authorities as risk zones or by geological surveys as rates along a shore.
- **Soil erosion** — the loss of soil from a land surface by water or wind. Measured in tonnes per
  hectare per year, published by soil and agriculture agencies, and almost always **modelled** rather
  than observed.

A layer that pooled them would be this record's invention. Every section below states which subject it
is about, and §3.2's table keeps them apart. The two verdicts differ, so the split is required.

### 2.2 United States, soil — USDA National Resources Inventory

All facts in this section read **2026-08-27**.

The issue flagged the NRI as sample-based and asked what resolution its erosion estimates support. **The
answer is state and national, and the reason is stronger than sampling error: the sample point locations
are withheld by statute, so no per-cell join exists to be attempted.**

**The product.** The current release is the **2022 NRI Summary Report, published September 2025**
([landing page](https://www.nrcs.usda.gov/nri);
[report PDF](https://www.nrcs.usda.gov/sites/default/files/2026-02/2022%20NRI%20Summary%20Report.pdf) —
HTTP 200, 12,666,474 bytes, 222 pages;
[Technical Manual](https://www.nrcs.usda.gov/sites/default/files/2023-10/NRI-TechnicalManual-October2023.pdf)
— HTTP 200, 1,813,543 bytes). Publisher: USDA NRCS with Iowa State University's Center for Survey
Statistics and Methodology.

**There is no downloadable NRI dataset.** The NRI section publishes PDFs and dashboards. The only route
to custom estimates is **LUCID** ([nrisurvey.org/lucid](https://www.nrisurvey.org/lucid/), HTTP 200,
84,340 bytes), a form-driven web application **with no public API** — a search of the page for AJAX
endpoints and for any `/api`, `/rest`, `/query` or `/export` path returned only static asset paths. The
[RCA Data Downloads page](https://www.nrcs.usda.gov/rca-data-downloads) (HTTP 200) carries four Excel
files, all conservation-practice or financial, **none of them NRI erosion** (each exercised by ranged
GET, all HTTP 206). The RCA erosion dashboard is Tableau, named `…ErosionbyStateNRI20171/ErosionTrends`
— **by State**, and labelled "current up to 2017".

**The decisive statement, verbatim** (2022 Summary Report, Chapter 7, p. 7-1):

> "The 1982 NRI was eventually designed to establish a database that would allow natural resource issues
> to be analyzed by portions of Major Land Resource Areas (MLRAs) within States. The initial desire was
> to have county-level reliability rather than the State-level reliability provided by the 1977 NRI, but
> it was determined that sufficient resources were not available; and the 1982 NRI sample design was
> ultimately a compromise because it provided **the equivalent of multi-county level reliability**."

And on what the report publishes: "This report presents selected NRI summary data at the **national and
State levels**."

**No sentence of the form "not designed for areas smaller than X" exists.** That absence was checked —
both PDFs were swept for `not designed | smaller than | not intended | should not be used | cannot be
used | county-level | sub-state` — and it matters, because USDA expresses the limit **positively** (what
reliability the design provides) and enforces it per query. LUCID's own legend: "**Yellow**: Margin of
error is 75 – 99% of the estimate. **Red**: Margin of error is > or = 100% of the estimate", beside a
column giving "the number of NRI points the estimate is based on". County figures are obtainable and the
tool marks them red when the margin of error equals or exceeds the estimate.

**Point locations are confidential, and this is the finding that closes the question.** From the NRI
landing page:

> "The location of NRI segments and points used to create the estimates and other identifying details
> are confidential information as mandated by law, **7 USC 2276**, and interpretive policy delineated in
> NRCS General Manual Title 290, Part 400.11, B(4) in Appendix A."

Technical Manual §1.4: "**NRI data that identify owners, operators, or data collection sites are not to
be released outside of USDA.**" The Summary Report repeats it as "not to be released to the public".

**A correction to the issue's premise.** The operative authority is **7 U.S.C. 2276**, not 7 U.S.C. 8791
/ Food Security Act §1770. Verified at
[law.cornell.edu/uscode/text/7/2276](https://www.law.cornell.edu/uscode/text/7/2276): subsection (d)(12)
covers the NRI collection authority, and disclosure is barred unless the information is "converted into
a statistical or aggregate form that does not allow the identification of the person that supplied
particular information". Every retrieved NRI document was searched for `8791` and `Section 1770`: zero
statutory citations. NRCS cites 2276 exclusively — 3 times in the Technical Manual, 4 in the Summary
Report, once on the landing page. This is not a claim that 8791 is legally inapplicable; it is that USDA
never invokes it for the NRI.

**Four further constraints from Chapter 5, each of which independently disqualifies a per-cell reading:**

1. **The erosion values are modelled, not measured.** "NRI erosion estimates are based upon erosion
   prediction models rather than on-site measuring of soil detachment, transport, and deposition."
   Sheet and rill uses USLE before 2008 and **RUSLE2 from 2008 to 2022**; wind uses **WEQ**.
2. **Long-term average climate, not actual weather.** "Climatic factors used in the erosion prediction
   equations (models) are based upon long-term average conditions and not upon one year's actual
   events."
3. **A restricted land subset.** "Erosion estimates are currently made only for cropland, Conservation
   Reserve Program (CRP) land, and pastureland. Erosion prediction models for rangeland are currently
   under development and evaluation." No forest, no developed land, no rangeland. Non-Federal land only.
4. **Wind erosion is not national.** "WEQ measures are only taken in selected states."

**Cadence.** Collected annually since 2000; released on a five-year cycle. The 2022 release landed
September 2025 — a three-year lag. Sample: over 800,000 points, ~71,000–72,000 segments per year.

**Licence.** No NRI-specific statement exists. The governing text is USDA-wide
([usda.gov/policies-and-links](https://www.usda.gov/policies-and-links), HTTP 200): "Most information
presented on the USDA Web site is considered public domain information… Some materials on the USDA Web
site are protected by copyright, trademark, or patent, and/or are provided for personal use only." Moot
here, because there is nothing to redistribute.

### 2.3 United States, soil — what SSURGO actually carries, and what it does not

All facts and measurements in this section taken **2026-08-27** through Soil Data Access
(`POST https://sdmdataaccess.nrcs.usda.gov/Tabular/post.rest`, anonymous, no key), the same service the
arability survey exercised. Response times measured between 0.39 s and 1.51 s. The component total
returned here is **1,288,808**, agreeing with that survey's figure taken the same day.

The arability survey established SSURGO's licence ("This is public information" in the shipped FGDC
metadata), its acquisition path, its four-way absence taxonomy and its annual refresh. None of that is
re-derived. What this section adds is the erosion question: **SSURGO carries erosion attributes, and
every one of them is about susceptibility or tolerance rather than about erosion occurring.**

**Physical factors, with measured availability.** NULL counts out of 1,288,808 components:

| column           | what it is                     | NULL    | NULL share |
| ---------------- | ------------------------------ | ------- | ---------- |
| `tfact`          | soil loss tolerance (T factor) | 271,880 | 21.1 %     |
| `weg`            | wind erodibility group         | 272,056 | 21.1 %     |
| `wei`            | wind erodibility index         | 342,703 | 26.6 %     |
| `slope_r`        | representative slope           | 171,657 | 13.3 %     |
| `slopelenusle_r` | USLE slope length              | 599,262 | 46.5 %     |
| `erocl`          | erosion class (observed)       | 832,660 | **64.6 %** |

`kwfact` / `kffact` (the K factor) live on `chorizon` and are well populated at the surface: on `IA153`,
329 surface horizons (`hzdept_r = 0`) with **5** NULL on each, values running .10 to .49.

**The K factor is one input of six, and NRCS says so.** Verbatim from `sdvattribute` for "K Factor,
Whole Soil":

> "Erosion factor K indicates the **susceptibility** of a soil to sheet and rill erosion by water. Factor
> K is **one of six factors** used in the Universal Soil Loss Equation (USLE) and the Revised Universal
> Soil Loss Equation (RUSLE) to predict the average annual rate of soil loss by sheet and rill erosion in
> tons per acre per year."

The five it is not include C (cover management) and P (support practices), which are properties of what
someone is doing with the land — the very thing the NRI samples and does not release per location.

**The T factor is a threshold, not a rate.** Its whole published description, 214 characters:

> "The T factor is an estimate of the **maximum average annual rate of soil erosion by wind and/or water
> that can occur without affecting crop productivity** over a sustained period. The rate is in tons per
> acre per year."

**The interpretations are conditional, and the agricultural ones are state-authored.** A DISTINCT query
over `distinterpmd` for rule names containing "rosion" returns **15 rules**. Every agricultural water or
wind erosion rule carries a state suffix — `AGR - Water Erosion Potential (NE)`, `(TX)`,
`AGR-Water Erosion Potential (ND)`, `AGR - Wind Erosion Potential (NE)`, `(TX)`, `AGR-Wind Erosion (ND)`
— and so do five of the seven forestry rules (`(MI)`, `(OH)`, `(ID)`, `(PIA)`, `(AK)`). **Exactly two
rules carry no state suffix**: `FOR - Potential Erosion Hazard (Off-Road/Off-Trail)` and
`FOR - Potential Erosion Hazard (Road/Trail)`.

That is the same problem 7 CFR 657.5 creates for `Farmland of statewide importance` in the arability
survey, arriving by a different route: a Texas water-erosion rating and a North Dakota one are not the
same claim, and pooling them would pool incompatible vocabularies.

The two national rules **are** populated, measured per survey area (components carrying the rule at
`ruledepth = 0`, against total components): `IA153` 369 ratings, `TX299` 140/140, `CA630` 584/584,
`AK655` 544/544, `FL001` 383/383. The `IA153` rating distribution: Slight 149, Moderate 128, Severe 39,
Very severe 10, **Not rated 43** — the absence category again, and it is not a low rating.

And the rating is conditional on a disturbance that has not happened. Verbatim from the same rule's
published description:

> "The ratings in this interpretation indicate the hazard of soil loss from off-road and off-trail areas
> **after disturbance activities that expose the soil surface**… The soil loss is caused by sheet or rill
> erosion in off-road or off-trail areas **where 50 to 75 percent of the surface has been exposed** by
> logging, grazing, mining, or other kinds of disturbance."

and from its NASIS narrative:

> "The rating is reported without regard to individual precipitation events… **Gully erosion and its
> impacts are not considered.** This rule does not deal with sediment production, delivery ratio,
> streambank or streambed erosion for water courses on the site."

with the standing caveat every SSURGO interpretation carries: "Onsite investigation may be needed to
validate these interpretations and to confirm the identity of the soil on a given site."

**The one place SSURGO records erosion that happened.** Two mechanisms, both thin:

- `component.erocl` — the erosion class, populated on 456,148 components (35.4 %). Measured domain:
  `Class 1` 226,014, `None - deposition` 176,081, `Class 2` 42,686, `Class 3` 9,956, `Class 4` 1,411.
  NRCS's prose definition of the classes was **not retrieved** (§8).
- **Special features** — point and line symbols in the `soilsf_*` shapefiles, defined per survey area in
  `featdesc`. Erosion-related symbols and the number of survey areas defining each: `ERO` Severely
  eroded spot **751**, `GUL` Gully **564**, `BLO` Blowout **261**, `SLI` Slide or slip **85**, `SER`
  Severely eroded spot 2, `ERA` Eroded areas 1, `SES` Severely eroded shoreline 1. **1,210 distinct
  survey areas** define at least one, against 2,542 defining any special feature and 3,380 in
  `sacatalog`. Verbatim `GUL` definition (from `AZ655`): "A small, steep-sided channel caused by erosion
  and cut in unconsolidated materials by concentrated but intermittent flow of water…"

Defining a symbol is not the same as holding features, and a spot symbol is mapped only where it is
large enough to note and small enough not to delineate. **The absence of a gully symbol is not the
absence of a gully**, and no NRCS statement makes it one.

One measured service behavior, matching the arability survey's: a whole-table `GROUP BY` over `cointerp`
for one rule returned **HTTP 400 with an OGC `ServiceExceptionReport` reading "Your query timed out."
after 90.6 s**. Scoped to a survey area the same query answers in under 3 s. A JSON-only parser
mis-reads that failure as success.

### 2.4 United States, coastal — USGS and NOAA

All facts and measurements in this section read **2026-08-27**.

**Reachability first, because the issue asked. The FEMA pattern did not reproduce: no USGS or NOAA host
reset a TLS handshake from this network.** Four distinct failure modes did appear and none of them is a
block:

| host                                     | measured                                                                               | what it is                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `www.usgs.gov`                           | plain curl 403 / 0.022 s / 919 B; with a browser header set 202 / 0.020 s / 1,995 B    | an **AWS WAF JavaScript challenge**, not a header requirement — no client reached content |
| `geoserver-production.cmgp.chs.usgs.gov` | `getaddrinfo` returns no A and no AAAA record                                          | **NXDOMAIN** — an internal hostname leaked into a portal's HTML                           |
| `coastalmap.marine.usgs.gov`             | port 80 CONNECT in 0.089 s and 301 → https; port 443 `ConnectionRefused` after 0.095 s | a redirect into a **closed port**, server-side                                            |
| `chs.coast.noaa.gov`                     | `/htdata/` 403 / 209 B; a file beneath it 200 / 154,784,547 B                          | directory listing denied, **file serving fine**                                           |

Everything else answered cleanly: `sciencebase.gov` 200/0.41 s, `marine.usgs.gov` 200/0.36 s,
`pubs.usgs.gov` 200/0.30 s, `coast.noaa.gov` 200/0.51 s, `shoreline.noaa.gov` 200/0.27 s,
`geodesy.noaa.gov` 200/0.36 s.

**USGS National Shoreline Change — a national erosion-rate dataset exists, it is new, and it is CC0.**

[DOI `10.5066/P14MTEZ3`](https://doi.org/10.5066/P14MTEZ3), ScienceBase item `694ac29ed4be023a64292d5c`,
"A compilation of published shoreline change rates (1800s-2010s) for the contiguous United States",
**publication date 2026-05-22**.

Licence, verbatim from the shipped FGDC `<useconst>`:

> "These data are marked with a Creative Commons CC0 1.0 Universal License. These data are in the public
> domain and do not have any use constraints… Please recognize the U.S. Geological Survey as the
> originator of the dataset. These data are not to be used for navigation."

Acquisition, measured:
`https://www.sciencebase.gov/catalog/file/get/6978fe92d4be0269295224a5?name=National_Shoreline_Change_Rates_LT.zip`
→ **HTTP 200, 10,063,056 bytes, 7.20 s**. One acquisition trap: the `files[].url` ScienceBase advertises
is `__s3__`-backed and returns a 4,255-byte HTML application shell; the `?name=` form above is what
works. A second: every regional child advertises ScienceBase WMS and WFS endpoints under
`https://www.sciencebase.gov/catalogMaps/mapping/ows/<id>`, and **all of them return 404** — tested for
WMS 1.3.0, WFS 1.0.0 and `GetFeature` on two items plus the bare path.

Contents, measured from the shapefile rather than from prose: **133,113 transects**, extent
(−124.594, 25.664) to (−69.777, 47.885), EPSG:4326, all 21 contiguous-US coastal states. **Transect
spacing measured** by haversine between consecutive `Point_X`/`Point_Y` at adjacent `USAorder` within
state (n = 131,244, gaps over 2 km excluded): **median 50.1 m, p10 49.1 m, p90 51.5 m**. Rates are
per-transect in `LRR` (least-squares linear regression, m/yr): n = 133,113, min −39.620, median −0.080,
max 33.510, mean −0.348; **78,714 of 133,113 (59.1 %) are negative**. `ShrCount` carries **9999 as a
sentinel** ("A value of 9999 indicates this metric was not calculated in the original dataset") — a
consumer that averages it produces a well-formed wrong answer.

What is excluded, in USGS's own completeness report:

> "Additional transects may have been generated but did not meet the required number of shorelines (3)
> or geomorphology constraints. **Shoreline change coverage is limited to open-ocean sandy coastlines.**"

and from the supplemental information: "Long-term rates of shoreline change were calculated using a
linear regression rate based on available shoreline data for **a minimum 50-year period**."

So bluffs, armoured shore, muddy and marsh shore, most sheltered bay and estuary shore, and the Great
Lakes are outside the product — as are Alaska (separate regional releases), Hawaii (only OFR 2011-1009,
covering Kauai, Oahu and Maui) and the territories. **There is no national short-term rate file** — the
item has exactly one child and one data archive, `..._Rates_LT.zip`; short-term rates exist only in the
regional releases. Two metadata disagreements worth carrying: `<ptvctcnt>` says 126,831 against the
measured 133,113, and `<transize>` says 9.8 MB against 10,063,056 bytes.

**USGS Coastal Change Hazards Portal** ([marine.usgs.gov/coastalchangehazardsportal](https://marine.usgs.gov/coastalchangehazardsportal/),
HTTP 200) is a viewer, and its data is reachable without it by two measured endpoints: an item-tree JSON
API (`/data/item/uber?subtree=true` → HTTP 200, 2,260,415 bytes, 1,032 nodes) and a proxied GeoServer
(`/geoserver/proxied/wfs` → `GetCapabilities` HTTP 200, 395,704 bytes; a live `GetFeature` returned
GeoJSON carrying `LRR`, `LR2`, `LSE`, `LCI90`). The GeoServer the portal names in its own HTML is the
NXDOMAIN host above; only the proxy path is public.

**USGS Coastal Vulnerability Index** — published as
[DDS-68](https://pubs.usgs.gov/dds/dds68/htmldocs/data.htm), `cvi.zip` measured at HTTP 200, 7,499,024
bytes. **No licence grant**: DDS-68 predates the modern data-release template and carries only a
warranty disclaimer. 15,165 segments (Atlantic 11,923, Gulf 1,607, Pacific 1,635), contiguous US only,
built on 1999–2000 inputs, `DBF_DATE_LAST_UPDATE` 2010-05-04. Not superseded by any newer national CVI —
a ScienceBase search returns none; the nearest successor, Coastal Change Likelihood
([DOI `10.5066/P96A2Q5X`](https://doi.org/10.5066/P96A2Q5X), 2023, 10 m), is explicitly a pilot study
covering Maine to Virginia.

**The CVI's resolution is not what a common summary says.** USGS's own statement: "The data are stored
in an attribute table associated with **a 1:2,000,000 shoreline at 3 minute resolution**. Thus, for each
3 minute (~5 km) section of shoreline…". Measured segment lengths from the shipped shapefiles disagree
with that "~5 km" for two of three coasts: Atlantic median **1.26 km** (p10 0.21, p90 4.66), Pacific
median **1.82 km**, Gulf median **5.15 km**. Both numbers are reported; neither is chosen. (The
frequently-cited "1:70,000" belongs to NOAA's Medium Resolution Shoreline, a different product.)

**USGS CoSMoS** — a model. Worked example verified: "Projections of shoreline change for California due
to 21st century sea-level rise" ([DOI `10.5066/P9CJMB2H`](https://doi.org/10.5066/P9CJMB2H), 2023-06-01),
one archive of 170,567,367 bytes, scenarios from 25 cm to 500 cm of sea-level rise, California only.

**NOAA Digital Coast publishes no erosion-rate dataset. That is a checked absence, and here is what was
enumerated.** The catalogue is fully client-rendered with no server-side registry API (five candidate
paths, all 404 or 302→404), so the registry was parsed out of the page's own bundle
(`digitalcoast/js/data-ba67936f.js`, 7,095,204 bytes): **3,645 dataset records across 49 collections.**
Only **2** carry the `erosion` tag and both are lidar acquisitions. Matching every title against
`/shorelin|erosion|change rate|accretion|bluff/i` returns **10**, all shoreline position, lidar,
hardened-shoreline classification or demographics. No collection is a shoreline-change collection.

What NOAA does hold that touches the subject:

- **C-CAP Regional Land Cover** — a **30 m land-cover** raster, 13 epochs 1975–2021, bulk download moved
  to Azure Blob (CONUS 2021 measured at 654,538,627 bytes). Its InPort use constraints: "**DATA SHOULD
  NOT BE USED FOR LEGALLY BINDING APPLICATIONS**", and the dataset page calls it "a screening tool for
  very local or site-specific management decisions". Land-to-water transitions across epochs are an
  _inference_, not a published rate.
- **Shoreline vectors** — CUSP (1:1,000–1:24,000, seven regional archives totalling 985.8 MB measured),
  the Historical Composite Shoreline (199,999,440 bytes) and the Historical Medium Resolution Shoreline
  (14,436,491 bytes, average 1:70,000). All three state where a shoreline **is**, at one vintage. They
  are the input to a rate, never a rate.
- **Sea Level Rise Viewer data** ([coast.noaa.gov/slrdata/](https://coast.noaa.gov/slrdata/), HTTP 200) —
  3–10 m inundation rasters and vectors for 30 states and territories, and **NOAA states in its own words
  that it is not this**: "These data illustrate the scale of potential flooding, not the exact location,
  and **do not account for erosion**, subsidence, or future construction." One state's vectors measured
  at 620.6 MB; one DEM list at 231.5 GB across 122 files.

**A licence caveat that binds every US federal source here.** Both stock "public domain" links —
`usa.gov/publicdomain/label/1.0/` and `usa.gov/government-works` — redirect to
[usa.gov/government-copyright](https://www.usa.gov/government-copyright), which declines a blanket
grant: "**Not everything that appears on a federal government website is a government work**… Check with
the federal agency or program that manages the website to make sure the materials are not restricted."
The only products in this section carrying a real, quotable grant are the **modern USGS ScienceBase data
releases with explicit CC0 1.0 in their FGDC `<useconst>`**. DDS-68, the Hawaii release (which credits
the University of Hawaii Coastal Geology Group) and every NOAA product carry a _disclaimer_ instead. Do
not launder a disclaimer into CC0 on the strength of a catalogue field.

### 2.5 England, coastal — the Environment Agency's National Coastal Erosion Risk Mapping

All facts and measurements in this section read **2026-08-27**. This is the pilot, and it is the section
where the issue's pessimism was wrong.

**The current product is
[National Coastal Erosion Risk Mapping (NCERM) - National (2024)](https://environment.data.gov.uk/dataset/9fede91f-5acd-4fd2-9bd8-98153fa3c2ff)**,
dataset id `9fede91f-5acd-4fd2-9bd8-98153fa3c2ff`, file-dataset id
`76509b7e-15e3-40ac-ac5c-bcc2fce4e71a`,
[data.gov.uk slug `national-coastal-erosion-risk-mapping-ncerm-national-2024`](https://www.data.gov.uk/dataset/e75374d5-ef4b-4f9f-abc1-6aefde4627b7).

**The name check mattered, because the old record follows the flood-zone pattern exactly.** A CKAN
`package_search?q=NCERM` returns three records. The 2018–2021 record
(`87badb85-3b4e-4a31-8a67-06972ee9aa93`) has `resources: []`, `files: []` and `publishedStatus:
"retired"`, with a note pointing at the replacement — the same gutting the flood survey documented for
Flood Zones 2 and 3. The third record, NCERM Key Summary Information, holds one spreadsheet
(`NCERM2024_PropertiesAtRisk_v202501.xlsx`, HTTP 200, 47,338 bytes) and **no geometry**.

**The 2024 record, by contrast, carries eight live resources**: four bulk archives, a
download-by-area page, WMS, WFS and OGC API Features. Sizes measured by GET (this host answers `HEAD`
with 405 and **ignores `Range`** — a `curl -r 0-1023` returned HTTP 200 with `size_download=70296882`,
the whole file; the same trap the flood survey recorded):

| format           | file name                                                           |       bytes |
| ---------------- | ------------------------------------------------------------------- | ----------: |
| file geodatabase | `National_Coastal_Erosion_Risk_Mapping_NCERM_National_2024.gdb.zip` |  70,296,882 |
| shapefile        | `…shp.zip`                                                          | 147,455,696 |
| GeoPackage       | `…gpkg.zip`                                                         | 158,185,978 |
| GeoJSON          | `…geojson.zip`                                                      | 185,929,420 |

Each matches the platform's own declared size byte for byte; the geodatabase opens under `ogrinfo`.

**A builder trap in the service path, and it is a typo.** The OGC service slug is **`ncern`**, not
`ncerm`: `…/spatialdata/ncerm-national-2024/wfs?…GetCapabilities` returns **HTTP 404**, while
`…/spatialdata/ncern-national-2024/wfs?…` returns **HTTP 200, 110,478 bytes**. Any client must use the
misspelling.

**Two independent paths agree exactly on the feature count.** WFS `resultType=hits` against all 14
feature types, and the geodatabase's own counts, both total **89,371**:

| layer family                                | layers | features |
| ------------------------------------------- | ------ | -------: |
| `NCERM_NFI_{2055,2105}_{0,70,95}CC`         | 6      |   44,230 |
| `NCERM_SMP_{2055,2105}_{0,70,95}CC`         | 6      |   44,981 |
| `NCERM_Ground_Instability_{Recession,Zone}` | 2      |      160 |

Geometry is `MultiPolygon` in **EPSG:27700** (British National Grid). The WFS reports a data extent of
(−6.985, 49.882) to (2.066, 55.810), tighter than the ISO bounding box.

**Licence — OGL v3.0, verified, with a published attribution string.** ISO 19115 metadata retrieved from
the EA's own CSW
(`https://environment.data.gov.uk/discover/ea/csw?service=CSW&version=2.0.2&request=GetRecordById&id=9fede91f-…&outputSchema=http://www.isotc211.org/2005/gmd&elementSetName=full`,
HTTP 200, 27,643 bytes) and byte-identically from data.gov.uk's harvest object.

- `gmd:useLimitation` — "Open Government Licence"
- `gmd:otherConstraints` — "There are no public access constraints to this data. Use of this data is
  subject to the licence identified."
- `gmd:accessConstraints` — `otherRestrictions`, `license`, `copyright`
- attribution, from the record's structured licence object:
  **"© Environment Agency copyright and/or database right 2025. All rights reserved."**
- WMS and WFS both report `<Fees>NONE</Fees>`

**Take the attribution from the structured field, not from the abstract.** The abstract ends with a
doubled and malformed pair — "…© Environment Agency copyright and/or database right Attribution
statement: © Environment Agency copyright and/or database right 2025. All rights reserved. " — whose
first copy is inherited from the superseded record and carries no year. There is **no `gmd:credit`
element** in the ISO record (checked: zero matches). The structured `attributionStatement` also carries
a trailing space.

**Dates and cadence.** `gmd:CI_Date`: creation 2024-11-28, publication 2025-01-28, revision 2024-11-28;
metadata `dateStamp` 2025-09-19. Bulk files were re-uploaded 2025-08-24/25 and each carries a
`previousSha256`, so the archives were replaced within the same product version. Maintenance frequency
is `MD_MaintenanceFrequencyCode codeListValue="annually"` — and **that is the entirety of the EA's
commitment; no prose names a publication month.** As of 2026-08-27 the 2024 edition is still current.
Lineage, verbatim: "NCERM uses a variety of coastal datasets including the Shoreline Management Plans."
INSPIRE theme: `Natural risk zones`.

**The schema — and the historical description of NCERM is now wrong.** The 2018–2021 product had three
horizons with 5th/50th/95th **percentile** bands. The 2024 product replaced that, and CKAN says so:
"Unlike the previous NCERM, data ranges based on percentiles are not provided." The layer naming is
`NCERM_{NFI|SMP}_{2055|2105}_{0|70|95}CC` — a cross product of:

- **management scenario**: `NFI` = No Future Intervention; `SMP` = With Shoreline Management Plans
  delivered
- **horizon**: `2055` Medium Term; `2105` Long Term
- **climate allowance**: `0CC` present day (2020); `70CC` and `95CC` the UKCP18 RCP8.5 sea-level-rise
  70th and 95th percentile allowances

Erosion-zone fields, verbatim from `DescribeFeatureType`: `frontageid` (int), `shape_leng`, `smp_no`,
`smp_name`, `smp_pu`, `mt_smp`, `mt_smp_int`, `lt_smp`, `lt_smp_int`, **the distance field**,
`maxoverlap`, `def_type`, `published`, `shape_length`, `shape_area`, `shape`. **The distance field's
name varies per layer** — `smp2105_95` on the SMP/2105/95CC layer, `nfi2055_0` on the NFI/2055/0CC layer
— and it is the cumulative erosion distance in metres. NFI layers omit the four `*_smp*` policy fields,
because there is no policy under a no-intervention scenario.

Coded values, from a full census of all 7,492 features of `NCERM_SMP_2105_95CC`:

- `mt_smp` / `lt_smp` (8 values each): `Hold The Line` 3608/3389, `No Active Intervention` 3063/3256,
  `Managed Realignment` 744/782, `Hold The Line / Managed Realignment` 33/23, blank 16/16,
  `Hold The Line / No Active Intervention` 13/4, `No Active Intervention / Managed Realignment` 12 —
  **spelled `No Active Intervention/Managed Realignment` without spaces in the other field** — and
  `Pending Agreement` 3/10.
- `mt_smp_int` / `lt_smp_int` (4 values): `Erosion restricted` 3941/3749, `Erosion unrestricted`
  3078/3497, `Stop Maintaining` 457/230, blank 16/16.
- `def_type` (14 values, and **dirty**): blank 3324, `Vertical Wall - Concrete` 1377, … plus
  **`Sheet Piles` 23 beside `Sheet piles` 112** and **`Vertical Wall - concrete` 1 beside
  `Vertical Wall - Concrete` 1377**. A consumer must case-fold this field.
- `published`: 2024 on 7,476 rows, `0` on the same 16 rows that are blank throughout.

**What the EA says it may and may not be used for**, verbatim from the abstract under the heading
`INFORMATION WARNINGS:`

> "The data and associated information are intended for guidance only - **it cannot provide details for
> individual properties**."

> "The data shows areas of land likely to be at erosion risk but **does not show the precise future
> position of the shoreline**."

> "Erosion may happen faster or slower than what we show, and risk may change over time."

> "The information is provided as best estimates based upon historic data termed 'present day' and, the
> higher central and upper end sea level rise climate change allowances representing UKCP18 RCP8.5 sea
> level rise projections. Unlike the previous NCERM, data ranges based on percentiles are not provided."

> "The NCERM information considers the predominant risk at the coast, although flooding and erosion
> processes are often linked, and data on erosion of foreshore features are, in general, not included."

The first of those is the sharpest constraint in this record, and it is the same shape as the
Environment Agency's flood-zone constraint and NRCS's onsite-investigation caveat: a map that is
authoritative about an area and explicitly declines to be authoritative about a property.

### 2.6 The rest of the United Kingdom — verified, and not interchangeable

All read **2026-08-27**. Each nation publishes something; none of them publishes the same thing, and a
"UK coastal erosion" layer built by pooling them would pool incompatible vocabularies — the same finding
the flood survey reached for flood zones.

- **Wales — Natural Resources Wales, "National Coastal Erosion Risk **Management**"** (note: Management,
  not Mapping). [DataMapWales layergroup](https://datamap.gov.wales/layergroups/geonode:nrw_ncerm),
  published 2023-07-10, OGL. Two layers, measured by WFS `resultType=hits`: `nrw_ncerm_all_nai`
  **4,998**, `nrw_ncerm_all_smp` **3,600**. **Wales is on the OLD NCERM generation** — three periods
  from a 2005 base (0–20, 20–50, 50–100 years) at the 50th percentile with 5–95th percentile attributes.
  Maintenance `notPlanned`. Licence, verbatim from `gmd:otherConstraints`: "© CNC/NRW Data may be
  re-used under the terms of the Open Government Licence providing it is done so, acknowledging both the
  source and NRW's copyright. It is the recipient's responsibility to ensure the data is fit for the
  intended purpose."
- **Scotland — Dynamic Coast / National Coastal Change Assessment**, NatureScot.
  [dynamiccoast.com](https://www.dynamiccoast.com/), downloads measured at
  `DYNAMICCOAST2_SCOTLAND_SHP_27700.zip` **569,264,779 bytes** and the GeoPackage **577,451,224 bytes**;
  WFS `dc2erosion2100high` `resultType=hits` **40,559**. Its access constraints carry a **stronger
  property-level prohibition than England's**, verbatim: `["Dynamic Coast analyses cannot be used for
property-level assessments.", "Available under an Open Government Licence: …"]`. The umbrella NCCA
  record's own constraint is vaguer — "Variable licencing please see individual record metadata" — so
  licence must be read per layer.
- **Northern Ireland — NI Coastal Erosion High Level Risk Appraisal**, DAERA/DfI via OpenDataNI, OGL.
  **122 features**, geometry `MultiLineString`, and the properties carry exactly one attribute:
  `{"risk": "Low"}`. A coarse coastline-segment banding, not comparable to NCERM's polygon zones.

### 2.7 EU level, soil — models, and redistribution forbidden

All read **2026-08-27**. `esdac.jrc.ec.europa.eu` answers HTTP 200 in 0.245 s and `land.copernicus.eu`
302s, so nothing here is a reachability finding.

**ESDAC soil erosion by water (RUSLE2015)**
([esdac.jrc.ec.europa.eu/content/soil-erosion-water-rusle2015](https://esdac.jrc.ec.europa.eu/content/soil-erosion-water-rusle2015),
HTTP 200) is a **model**, in its own words: "is the result of applying a modified version of the Revised
Universal Soil Loss Equation (RUSLE) model, RUSLE 2015". 100 m raster, EU-28, ETRS89 LAEA, time
reference 2010 and 2016, released 2015-09-01. Access is a **request form only**; there is no anonymous
file endpoint.

Its Notification block is the licence, and it forbids exactly what a shipped layer does, verbatim:

> "The permission to use the data specified above is granted on condition that, under **NO CIRCUMSTANCES
> are these data passed to third parties**. They can be used for any purpose, including commercial gain."

The component factors are separate datasets at **different resolutions**, each with its own Notification:
R (rainfall erosivity) **500 m**, K (soil erodibility) **500 m**, LS **25 m per country / 100 m
Europe-wide**, C (cover management) **100 m**, P (support practices) **1 km**. So the headline 100 m
product has two 500 m inputs and one 1 km input.

**GloSEM** exists in two forms and neither helps.
[`/content/global-soil-erosion`](https://esdac.jrc.ec.europa.eu/content/global-soil-erosion) is
distributed at **25 km** — "We used the 250m original data to re-sample at 25km" — and
[`/content/glosem`](https://esdac.jrc.ec.europa.eu/content/glosem) is GloSEM 1.3 at 100 m, **croplands
only**, about 10 % of the global land surface. Both carry the no-third-parties clause. The page routes
European users away from itself.

**PESERA**, the other pan-European model, is 1 km, released 2004, covering 23 member states. The EEA
serves the same raster anonymously (record `4dccd960-23ff-42ae-aab5-d35bfcf0c37b`) but marks it
`obsolete`, and its `MD_Constraints/useLimitation` is **stricter** than the RUSLE2015 family's: "…under
NO CIRCUMSTANCES are these data passed to third parties. Moreover they must NOT be used in any way for
commercial gain…". **The trap:** the EEA's own search index and its public datahub page both show PESERA
as "no limitations to public access", because the restriction sits in a field neither surface reads.

**There are no EEA soil-erosion indicators.** Checked by enumeration, not by search: the complete
indicator listing was pulled through the Plone REST API — 546 items, 89 of them `ims_indicator` — and
grepping all 89 titles for `erosion|coast|soil|shorelin|sediment|degrad` returns four, none about
erosion. Site-wide `SearchableText=erosion` returns 167 items: 43 Document, 42 topic pages, 28
infographics, 16 briefings, 15 static maps, and **zero indicators and zero datasets**.

**One EU soil-erosion product downloads anonymously, and it is regional by construction.** ESDAC's
NUTS-aggregated indicator ([themes/indicators-soil-erosion](https://esdac.jrc.ec.europa.eu/themes/indicators-soil-erosion))
serves `nuts2_Mean_2016.zip` at HTTP 200, 3,528,614 bytes. Opened: an ESRI shapefile, **271 polygon
features**, EPSG:3035, two attributes — `NUTS_ID` and `MSER` (mean soil erosion rate). It is RUSLE2015
averaged to administrative units. **No licence statement attaches to these files**; they sit outside the
request-form Notification, and ESDAC has no site-wide policy page (22 candidate URLs across this survey
and its sibling, all 404). Anonymous availability is not a licence.

**The EU Soil Monitoring Law creates no dataset yet.** Directive (EU) 2025/2360 entered into force
2025-12-16; the Commission's own
[news page](https://environment.ec.europa.eu/news/first-eu-law-soil-set-enter-force-2025-12-05_en)
mentions "a brand-new soil health data portal" without stating it has launched or holds erosion data.
Member states have three years to transpose. The Directive's own text could not be read (§8).

### 2.8 EU level, coastal — one survey, two model products, and three licence contradictions

All read **2026-08-27**.

**EUROSION is alive, downloadable and not deprecated.** EEA SDI record
`2c7b31f9-193e-48bb-a9a7-02470fb6b042`, "Geomorphology, Geology, Erosion trends and Coastal defence
works, version 2.1" — the 2004 EUROSION project for DG Environment. Downloaded and opened: **51,738
LineString features**, EPSG:4258, scale **1:100,000**, companion shoreline record stating "average
accuracy estimated to 50 meters". Bulk archive measured at HTTP 200, **59,631,124 bytes**, anonymous.

**Its erosion attribute is a class, never a rate.** `CEEVV2` across 51,738 segments: null **17,092
(33.0 %)**, "Stable: evolution almost not perceptible at human scale" 11,949, "Generally stable;
evolutionary trend is uncertain" 5,107, "No information on evolution" 3,867, "Out of nomenclature"
3,843, "Erosion confirmed, generalised" 2,232, "Erosion probable but not documented" 2,052, "Erosion
confirmed, localised" 1,794, plus three aggradation classes. Confirmed erosion totals 4,026 segments.
Vintage 2002–2004, maintenance frequency `unknown` — **no cadence at all**.

Licence, verbatim from the record: "As a EUROSION assignment, this layer is publicly available inside
and outside the European Commission provided that the source is acknowledged… Copyright holder:
European Environment Agency (EEA)", access "no limitations to public access", with the EEA legal notice
resolving to CC-BY.

**A better-licensed carrier of the same attributes exists.** Corine Land Cover 2000 Coastline (record
`d047cdb1-a62b-4299-8469-9038519430c0`) carries the EUROSION attributes — its lineage says so — over
**87,243 features**, with **explicit CC-BY 4.0** in the record XML and denser coverage: `CEEV` is null
on 15.4 % against EUROSION's 33.0 %.

**Copernicus Coastal Zones is land cover, and it answers no erosion question.** Verbatim: "provides
detailed land cover and land use information for 71 thematic classes for all European coastal territory
to a landward distance of 10 km". Vector, MMU 0.5 ha, MMW 10 m, EPSG:3035, editions 2012 and 2018 plus a
2012–2018 **land-cover** change layer. Licence is Commission Delegated Regulation (EU) No 1159/2013 plus
Regulation 2021/696 — **no Creative Commons anywhere**, and the record and portal agree. The view
service is anonymous (WMS `GetCapabilities` HTTP 200); the download service returns **HTTP 401**
anonymously, exactly as Article 18(1) requires.

**The JRC publishes two global shoreline products, and both carry a licence contradiction.**

- **Global long-term shoreline evolution** ([JRC dataset `944f6d9b-…`](https://data.jrc.ec.europa.eu/dataset/944f6d9b-2fbf-422e-ae3e-4b3aa391ed48)),
  downloaded in full: NetCDF-4, **411,473,458 bytes**, one dimension `transect` of size **2,142,679**.
  **The published quantity is a length in metres, not a rate** — `landtosea`, `seatoland` and four
  siblings all carry `unit = m` and `long_name = "transition length …"`, with `firstYear` and `lastYear`
  alongside, so a rate is derivable and is not published. **Latitude is hard-capped at ±63°** (measured
  range −62.994 to 62.997), which silently removes northern Norway, northern Sweden, northern Finland,
  most of Iceland and the Faroes — while the ISO metadata declares a −90/90 bounding box. Transect
  spacing in a European window, measured over 199,494 consecutive same-segment pairs: **median 141.7 m**
  (p10 122.5, p90 196.0). Licence: a `copyright.txt` in the same folder says **CC BY 4.0**; the ISO
  metadata beside it carries `otherRestrictions` = **`geossNonCommercial`**. Reported as a contradiction,
  not resolved.
- **Global shoreline change projections** (Vousdoukas et al.), 55,139,380 bytes, CSV, 2050 and 2100 under
  RCP4.5 and RCP8.5 with percentiles — projections, sandy coastlines only.

**EMODnet Geology's coastal-behaviour products are two different things under one name**, and both were
measured. _Field data_ (`tno:coastal_migration_fd_*`) is a survey compilation, **219,599 features**, ~50 m
segments (measured median 49.2 m), attributes `id, fid, migration, migrationrate, period` — and **no
country field at all**, so per-country provenance is unrecoverable from the service. _Satellite_
(`tno:coastal_migration_satellite`) is an algorithm output, **469,209 features**, point transects at
**~288 m** (measured median 287.6 m), carrying `changerate` in m/yr.

Three findings about it that a consumer must carry:

1. **It is a patchwork, and reading the head misreports it.** A stratified sample (20 offsets × 400 =
   8,000 of 219,599) shows availability arriving in contiguous contributor blocks: one offset gave 400
   `-9999`, another 400 nulls, another 400 usable. **Reading the head alone reports 85.0 % `-9999`; the
   stratified read reports 23.8 % `-9999`, 18.6 % null, 57.7 % usable.**
2. **Class and rate disagree, under three different thresholds.** On 4,613 field rows with a usable rate,
   `migration = 'stable'` has `migrationrate` exactly 0.000 in all 3,098 cases — a fill, not a
   measurement — and 19.8 % of rows contradict the documented ±0.5 m/yr criterion. On the satellite
   layer `cr_class10` thresholds at ±0.5 m/yr while `cr_class3` thresholds at ±2.0 m/yr, and
   **`cr_class3` has no Unknown class**, so all 779 rows `cr_class4` marks Unknown are forced into a
   positive class (358
   Stable, 274 Accretion, 147 Erosion) — with median `rmse` 43.23 against 7.12 for the rest. A reader
   taking `cr_class3` gets "Stable" where the data says it could not measure.
3. **A three-way licence contradiction.** The portal terms say **CC-BY 4.0** and tell the reader to
   consult the per-dataset metadata; that metadata says **CC BY-SA 4.0**; the WFS and WMS capabilities
   name no CC licence and assert partner-held IPR. Share-alike is materially more restrictive
   downstream. Reported, not resolved.

### 2.9 Deliberately not surveyed

- **Coastal and soil products of member states other than England**, and of US states. Each publishes
  under its own terms with its own vocabulary; none was verified and none is claimed.
- **Third-party derived shoreline measurements**, such as ShorelineMonitor
  ([shorelinemonitor.earth](https://shorelinemonitor.earth/), HTTP 200, reachable). These are research
  measurements, not an authority's designation, and the layer's whole value is that it repeats an
  authority. Its licence and access were not verified.
- **Landslide and ground-stability products beyond NCERM's two ground-instability layers.** A different
  hazard with different authorities.
- **England soil-erosion risk mapping — a checked absence, and worth recording because the obvious
  candidate exists and ships nothing.** Defra's `Soil Erosion and Compaction Risk Groups` (CKAN
  `3524b81e-9968-460a-a8aa-8ec2397d9dde`) is **retired with `num_resources: 0`**, its note reading "This
  dataset has been withdrawn while it is being reviewed and updated." Cranfield's LandIS erosion page
  returns **HTTP 404** and the LandIS data index carries no erosion link; an organisation-scoped query
  against the new open LandIS portal returned **71 items, zero containing "erosion"**.

### 2.10 The inventory, side by side

|                         | **EA — NCERM National (2024)**                             | **USGS — National Shoreline Change**                    | **USDA — NRI**                                      | **NRCS — SSURGO erosion attributes**                     | **EU level**                                             |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| subject                 | coastal                                                    | coastal                                                 | soil                                                | soil                                                     | both                                                     |
| what it is              | an authority's **designation** under a named scenario      | an authority's **measurement** of past rates            | a **sample-based statistical estimate**             | soil properties + **conditional** hazard interpretations | **models**, plus one 2004 survey compilation             |
| licence                 | **OGL v3.0**, attribution string published                 | **CC0 1.0**, in the shipped FGDC                        | no product licence; nothing to redistribute         | "This is public information" in the shipped FGDC         | ESDAC **forbids third parties**; two CC contradictions   |
| extent                  | England coast; data bbox −6.985/49.882 → 2.066/55.810      | 21 contiguous states, **open-ocean sandy shore only**   | non-Federal US; cropland/CRP/pasture only           | 3,380 survey areas                                       | EU-28 for the models; EU-25 coasts for EUROSION          |
| vocabulary              | 12 scenario layers; distance in metres; SMP policy classes | `LRR` m/yr per transect                                 | tonnes/acre/year with a margin of error             | K 0.02–0.69; T 1–5; hazard Slight→Very severe            | t/ha/yr; EUROSION 11 trend classes                       |
| resolution              | MultiPolygon zones on coastal frontages                    | **~50 m** transects (median 50.1 m measured)            | **state**; county via LUCID only, to 2017           | map-unit component                                       | 100 m–25 km rasters; 1:100,000 lines; ~142 m / ~288 m    |
| vintage                 | creation 2024-11-28, publication 2025-01-28                | published 2026-05-22; shorelines 1830–2018              | 2022 data, published Sept 2025; LUCID stops at 2017 | refresh 2025-10-01; survey far older                     | RUSLE2015 t.r. 2010/2016; EUROSION 2002–2004             |
| cadence                 | ISO `annually`, no month stated                            | irregular; this is the first national roll-up           | annual collection, five-year release                | one annual refresh                                       | EUROSION `unknown`; Coastal Zones moving six→three years |
| acquisition             | 4 direct file URLs + WFS + WMS + OGC API Features          | ScienceBase `?name=` archive; **OGC endpoints all 404** | **none — no dataset exists**                        | SDA + survey-area archives                               | ESDAC **request form**; CLMS **401**; EMODnet anonymous  |
| reachable from this lab | **yes** — 561.9 MB measured across four formats            | **yes** — 10,063,056 bytes measured                     | PDFs yes; there is no data endpoint                 | **yes** — SDA 0.39–1.51 s                                | mostly; `eur-lex.europa.eu` returned **0 bytes**         |
| usable for this layer   | **yes — the pilot**                                        | yes later, as a rate observation with its own semantics | **no**                                              | **no** — susceptibility, not erosion                     | **no** — models, restricted, or contradictory            |

## 3. What each source's resolution supports

This is the section the issue asked for by name. It comes before the schema because the schema is
downstream of it: a source that supports only a regional claim gets no cell table, however convenient a
cell table would be.

### 3.1 The claim a coverage row is allowed to make

`CoverageBasis.Designated` means "An authority declares the set complete for this cell". The set an
erosion authority declares complete is **its own mapping under its own scenario**, not the world's
erosion. So the strongest claim this layer can support is:

> the authority's map assigns this erosion designation, under this named scenario and horizon, to the
> location

and never

> this property will (or will not) erode.

Both of the two carryable authorities decline the second reading in their own words. The Environment
Agency: "The data and associated information are intended for guidance only - it cannot provide details
for individual properties." NRCS, on every soil interpretation: "Onsite investigation may be needed to
validate these interpretations and to confirm the identity of the soil on a given site." Scotland's
NatureScot is blunter still: "Dynamic Coast analyses cannot be used for property-level assessments."

**A scenario is part of the claim, not a parameter of it.** NCERM ships twelve layers because the answer
depends on which management scenario, which horizon and which sea-level-rise allowance the reader means.
A layer that folded them into one "erosion risk" value would be answering a question no authority asked.
`absence-route.ts` already holds this line for classes — it refuses unless the layer holds exactly one
class and the answered class is it — and the same rule extends to scenarios: **one artifact holds one
scenario, or the scenario is a column the reader must supply and the observation must name.**

### 3.2 The resolution-supports-what statement, per source

Each row is the verdict this survey was asked to produce. "Supports" means: the finest spatial claim the
source's own resolution and its own words license.

| source                                        | subject | what its resolution supports                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **USDA NRI**                                  | soil    | **State and national claims only.** The design gives "the equivalent of multi-county level reliability"; county figures exist only in LUCID, only to 2017, and the tool flags them red when the margin of error meets or exceeds the estimate. **No per-cell claim is reachable at any effort**, because the sample point locations are withheld under 7 U.S.C. 2276. |
| **SSURGO K / T factors**                      | soil    | A **per-map-unit-component** claim about the soil's **susceptibility** to erosion (K), or about the loss rate it could sustain (T). Neither is a claim that erosion is occurring: K is one of six USLE factors and the other five are not in the source.                                                                                                              |
| **SSURGO national erosion interpretations**   | soil    | A **per-map-unit-component** claim about the hazard **conditional on a disturbance that has not happened** — NRCS assumes "50 to 75 percent of the surface has been exposed". Gully erosion, sediment delivery and streambank erosion are excluded by the rule's own text.                                                                                            |
| **SSURGO state erosion interpretations**      | soil    | A **per-component claim inside one state**, not comparable across states — the rule names carry state suffixes and the criteria are state-authored.                                                                                                                                                                                                                   |
| **SSURGO special features** (`GUL`, `ERO`, …) | soil    | A **per-feature** claim that the surveyor mapped an eroded spot, gully or blowout **there**. It supports presence only: 1,210 of 3,380 survey areas define any such symbol, and absence of a symbol is not absence of the feature.                                                                                                                                    |
| **USGS National Shoreline Change**            | coastal | A **per-transect claim at ~50 m alongshore, on open-ocean sandy shoreline, and nothing off that line.** Long-term rates only, contiguous US only. It is a measurement of the past, not a designation of risk.                                                                                                                                                         |
| **USGS Coastal Vulnerability Index**          | coastal | A **regional screening claim only** — a five-class relative ranking on a 1:2,000,000 base line, nominally 3-minute sampling, measured segment medians 1.26 km (Atlantic) to 5.15 km (Gulf), on 1999–2000 inputs.                                                                                                                                                      |
| **USGS CoSMoS**                               | coastal | A **per-location projection under a named sea-level-rise scenario**, California only. Never a statement about what has happened.                                                                                                                                                                                                                                      |
| **NOAA C-CAP**                                | coastal | A **30 m claim about land cover**, which NOAA labels a screening tool. Land-to-water transition across epochs is the reader's inference, not a published rate.                                                                                                                                                                                                        |
| **NOAA shoreline vectors**                    | coastal | A claim about **where a shoreline was at one vintage**. The input to a rate, never a rate.                                                                                                                                                                                                                                                                            |
| **NOAA Sea Level Rise Viewer**                | —       | **Nothing about erosion.** NOAA states the data "do not account for erosion". A 3–10 m inundation claim under a static rise.                                                                                                                                                                                                                                          |
| **EA NCERM National (2024)**                  | coastal | A **per-polygon claim about a coastal frontage under one named management scenario, horizon and climate allowance** — that the EA's mapping places the location inside the area likely to be at erosion risk. The EA forbids a per-property reading in writing.                                                                                                       |
| **NRW NCERM (Wales)**                         | coastal | The same shape on the **previous generation's vocabulary** (three periods from a 2005 base, percentile bands), not interchangeable with England's.                                                                                                                                                                                                                    |
| **Dynamic Coast (Scotland)**                  | coastal | A per-polygon claim under a stated emissions scenario, with an **explicit prohibition on property-level assessment** in its own access constraints.                                                                                                                                                                                                                   |
| **NI High Level Risk Appraisal**              | coastal | A **per-coastline-segment banding** over 122 features carrying one attribute. A national screening statement, nothing finer.                                                                                                                                                                                                                                          |
| **ESDAC RUSLE2015**                           | soil    | A **100 m modelled hillslope claim**, not a parcel claim — the model's inputs (land cover, a DEM, crop statistics) carry no parcel identity, and two of its five factors are 500 m and one is 1 km.                                                                                                                                                                   |
| **ESDAC NUTS2 indicator**                     | soil    | A **per-NUTS2-region claim** over 271 polygons, and nothing about any location inside a region.                                                                                                                                                                                                                                                                       |
| **GloSEM (distributed)**                      | soil    | A **25 km claim** — country or large-region scale. The 100 m variant covers croplands only.                                                                                                                                                                                                                                                                           |
| **PESERA**                                    | soil    | A **1 km modelled claim**, 2004, marked obsolete by the EEA.                                                                                                                                                                                                                                                                                                          |
| **EUROSION / CLC2000 Coastline**              | coastal | A **per-segment categorical trend claim** on a 1:100,000 line with ~50 m accuracy, from 2002–2004, with 33 % of segments carrying no class. Not convertible into a rate.                                                                                                                                                                                              |
| **Copernicus Coastal Zones**                  | —       | A **0.5 ha land-cover claim** within 10 km of the coast, and **no erosion claim of any kind**.                                                                                                                                                                                                                                                                        |
| **JRC LISCOAST shoreline**                    | coastal | A **per-transect claim at ~142 m** carrying a net displacement in metres over 1984–2015 — and none at all above 63° N.                                                                                                                                                                                                                                                |
| **EMODnet Geology coastal behaviour**         | coastal | A **per-segment claim at ~50 m (field) or ~288 m (satellite)** whose class was set by an unnamed national method under one of three thresholds, over a patchwork with 42 % of field rows unusable.                                                                                                                                                                    |

### 3.3 Coverage honesty — England, and the one thing the pilot cannot yet claim

**The Environment Agency publishes erosion zones and no coverage statement.** This is where NCERM
differs from the flood product, and it inverts the flood layer's central rule.

For flood zones, England-wide coverage is stated and Zone 1 is _defined as the absence_: "all land
outside Zones 2, 3a and 3b". A location with no polygon is a designation. **For erosion there is no such
definition.** A location in England with no NCERM polygon is one of two entirely different things:

1. **not on the coast at all** — most of England, and about which NCERM says nothing; or
2. **on the coast, and not expected to be reached by erosion within this horizon under this scenario** —
   which is a designation and is exactly what a caller wants.

**The published layers cannot tell those apart**, and a builder that copied the flood layer's rule would
write `designated, completeness = 1.0` over all of England and thereby convert "inland" into "no erosion
risk". That is the failure this program exists to prevent, arriving through a rule that was correct for
the previous layer.

**So the pilot ships `CoverageBasis.SourcePresent` until a mapped-footprint source is settled.** That
basis supports presence and nothing else, which is precisely the honest state: `supportsExclusion` is
false, no negative claim is licensed, and the observation reports the polygon it found or reports
nothing.

Two candidate footprint sources are named here and **neither was verified** (§8):

- **The EA's Shoreline Management Plan Mapping record**, a sibling dataset on the same platform carrying
  four spatial formats plus a `.lyr` file. NCERM's own lineage states it is derived from the Shoreline
  Management Plans, and every erosion-zone feature carries `smp_no`, `smp_name` and `smp_pu`, so the SMP
  polygon set is the obvious candidate. **Whether it states a footprint covering the whole English coast
  was not established** — its coverage statement, licence, extent and schema were not read.
- **The frontage geometry behind `frontageid`**, which every erosion-zone feature carries. Whether the
  EA publishes the frontages themselves, rather than only their id, was not established.

Deriving the footprint from the union of the erosion polygons is forbidden for the same reason the flood
survey forbids deriving `flood_map_extent` from the hazard polygons: the union of "at risk" areas is not
the mapped area, and the difference is the whole content of a negative answer.

**Two further limits the coverage row cannot express**, both from the EA's own text:

1. **The product covers the predominant risk and excludes foreshore features.** "The NCERM information
   considers the predominant risk at the coast, although flooding and erosion processes are often
   linked, and data on erosion of foreshore features are, in general, not included." An NCERM answer is
   silent about flooding, and the observation must name the product so a reader can see what it covers.
2. **The 16 anomalous rows.** Sixteen features per layer carry blank policy and defence fields and
   `published = 0`. Whether they are a defect or a placeholder is undocumented; a builder must carry them
   as-is rather than drop or coerce them.

### 3.4 Coverage honesty — the US soil sources

**The NRI writes no coverage rows because it writes no rows.** There is nothing to be honest about
spatially; the honesty is in not building it.

**SSURGO's four-way absence taxonomy carries over unchanged** from the arability survey — outside a
survey area, `NOTCOM`, access-denied, and not-rated — and erosion adds a fifth that is specific to it:
**`interphrc = 'Not rated'` inside a populated interpretation**, measured at 43 of 369 components on
`IA153`. That is neither "no hazard" nor "low hazard"; it is the interpretation declining to rate the
component, and it must be stored apart from the four rating classes exactly as the arability layer keeps
`unrated_share` apart from capability class 8.

And the erosion-class column carries the same hazard at larger scale: `erocl` is NULL on **64.6 %** of
components. Read as "no erosion observed" it would be wrong about two rows in three.

### 3.5 Coverage honesty — the shoreline-change products

**A cell with no transect means "no shoreline here", never "no erosion here".** This is the
meaning-of-zero rule in its sharpest form, because the geometry makes the mistake easy: a transect layer
covers a one-dimensional set inside a two-dimensional cell space, so the overwhelming majority of cells
have no row, and every one of those absences is about geography rather than about erosion.

Three further absences in the USGS product, each distinct and none of them coverage:

1. **Off the sandy open-ocean shore** — bluffs, armour, marsh, estuaries, the Great Lakes. Excluded by
   USGS's own completeness report. No row, and no claim.
2. **Fewer than three shorelines, or a failed geomorphology constraint** — a transect that USGS declined
   to rate. Also no row.
3. **`ShrCount = 9999`** — the sentinel meaning "this metric was not calculated in the original
   dataset". A row exists and carries a number that is not a count.

For EMODnet the equivalent absences are `-9999` and null, at 23.8 % and 18.6 % of a stratified sample —
and the head-of-table read that says 85.0 % is the trap, not the finding.

## 4. The layer schema sketch

### 4.1 The vocabulary is the authority's, verbatim

The layer stores the value the authority published, in the authority's spelling, with the authority's
date and the authority's scenario. No erosion score, no severity ordering, no cross-country scale.
England's `Erosion restricted` under a `Hold The Line` policy and a USGS `LRR` of −0.4 m/yr are not two
readings of one quantity.

The builder carries each declared domain as a closed set and **throws** on a value outside it. An unknown
code is a source-schema change, which is the event a reader most needs to hear about; coercing it to a
nearest neighbour or to NULL converts "the source changed" into "there is nothing here".

Two source-specific parsing rules that follow from the measurements:

- **Case-fold `def_type`.** The census found `Sheet Piles` beside `Sheet piles` and `Vertical Wall -
concrete` beside `Vertical Wall - Concrete`. Store the source string and compare case-insensitively;
  do not normalize the stored value.
- **Do not assume the policy strings match between the medium- and long-term fields.** `No Active
Intervention / Managed Realignment` in `mt_smp` is spelled `No Active Intervention/Managed
Realignment` in `lt_smp`.

### 4.2 Which storage shape each source takes — and the third shape

The inherited size contract settles two shapes: the **polygon rule** (#1989) and the **raster rule**
(#1984). Erosion introduces a source geometry neither covers, so this record states the third.

| source                                              | geometry               | shape that applies                                 |
| --------------------------------------------------- | ---------------------- | -------------------------------------------------- |
| **EA NCERM — the pilot**                            | MultiPolygon zones     | **the polygon rule**                               |
| Dynamic Coast, NRW NCERM                            | polygons               | the polygon rule                                   |
| ESDAC RUSLE2015, GloSEM, PESERA                     | rasters at 100 m–25 km | the raster rule                                    |
| NOAA C-CAP                                          | 30 m raster            | the raster rule                                    |
| SSURGO map units                                    | vector polygons        | the polygon rule (as the arability survey settled) |
| **USGS transects, JRC LISCOAST, EMODnet satellite** | points on a line       | **the linear rule, below**                         |
| **EUROSION, EMODnet field data, NI appraisal**      | polylines              | **the linear rule, below**                         |

**The linear rule.** A source whose geometry is a line or a set of points along one is neither an area
nor a grid, and the polygon rule's implementation does not apply to it:

- **The authority's polylines or transect points are the truth table**, stored unsimplified with a
  precomputed bounding box, exactly as the polygon rule stores rings.
- **The cell table records intersection, not containment.** There is no `whole` / `partial` distinction,
  because a line has no interior — a cell either is touched by the feature or is not. `compactCells` has
  nothing to collapse, and that is fine: a linear layer is small by construction, because its index
  scales with the length of the feature rather than with the area the feature sits in. A res-9 cell is
  200.8 m on an edge and 347.8 m across the flats (measured with h3-js 4.5.0), so a 1,000 km shoreline
  occupies on the order of 3,000 cells.
- **There is no polyline coverage primitive in h3-js**, checked: the library offers `polygonToCells` for
  areas and `gridPathCells` between two cells, and nothing that indexes a polyline. A linear builder
  densifies its vertices at a step **below the cell edge length** and indexes each sample, and it must
  record the step — a step above the edge length skips cells silently.
- **Absence is no row, and the absence means something different from the polygon case.** A cell with no
  line is not "no signal": it is "the feature this layer describes does not pass through here". §3.5 is
  why that has to be carried structurally rather than in prose.

The pilot is polygon-shaped, so the linear rule is stated here for the record and is not exercised by
it. The USGS transect layer is where it would first be used.

### 4.3 Tables

Five domain tables plus the two contract tables, written as Kysely schema modules with the typed
interface co-located with its `createXTable`, per the house database discipline.

```
erosion_zone_area           -- THE TRUTH: one row per authority polygon, plain rowid (it holds a blob)
  area_id          TEXT PRIMARY KEY   -- authority feature id, scoped by scenario (see below)
  frontage_id      TEXT      -- the EA's frontageid; the join to the frontage the zone belongs to
  scenario_id      TEXT      -- 'NFI' | 'SMP' — the management scenario, part of the claim
  horizon          INTEGER   -- 2055 | 2105
  climate_allowance TEXT     -- '0CC' | '70CC' | '95CC'
  distance_m       REAL      -- the cumulative erosion distance, from the layer's own distance column
  smp_no           INTEGER?
  smp_name         TEXT?
  smp_pu           TEXT?
  mt_policy        TEXT?     -- mt_smp, verbatim; NULL on NFI layers, where no policy applies
  mt_policy_interp TEXT?     -- mt_smp_int: 'Erosion restricted' | 'Erosion unrestricted' | 'Stop Maintaining'
  lt_policy        TEXT?     -- lt_smp
  lt_policy_interp TEXT?     -- lt_smp_int
  defence_type     TEXT?     -- def_type, verbatim; case-fold to compare, never to store
  published_year   INTEGER?  -- 2024, or 0 on the 16 anomalous rows — carried, not coerced
  min_lat, min_lon, max_lat, max_lon  REAL   -- precomputed bbox, the ray-cast prefilter
  rings            BLOB      -- the authority's ring coordinates, UNSIMPLIFIED

erosion_zone_cell           -- the build-time containment index, WITHOUT ROWID
  h3_cell          INTEGER   -- 48-bit short cell at the declared resolution
  area_id          TEXT
  containment      TEXT      -- 'whole' | 'partial'
  PRIMARY KEY (h3_cell, area_id)

erosion_ground_instability  -- NCERM's two ground-instability layers; a different hazard, kept apart
  area_id          TEXT PRIMARY KEY
  kind             TEXT      -- 'zone' | 'recession'
  local_authority  TEXT?
  smp_no           INTEGER?
  min_lat, min_lon, max_lat, max_lon  REAL
  rings            BLOB

erosion_mapped_extent       -- the authority's mapped footprint, NOT the union of erosion polygons
  extent_id        TEXT PRIMARY KEY
  source           TEXT      -- which published product this footprint came from
  effective_date   TEXT?
                             -- EMPTY IN THE PILOT: §3.3 — the EA publishes no coverage statement, and
                             -- until a footprint source is settled this table stays unpopulated and
                             -- layer_coverage carries basis = source_present

erosion_scenario_vocabulary -- the authority's declared scenario and policy domains, as shipped
  field            TEXT      -- 'scenario_id' | 'mt_policy_interp' | 'defence_type' | …
  value            TEXT
  definition       TEXT      -- the authority's own words
  definition_url   TEXT

layer_manifest / layer_coverage   -- the contract tables, from @mailwoman/core/layers
```

`WITHOUT ROWID` on `erosion_zone_cell` and not on the geometry tables follows the contract's own
guidance — small fixed-width rows probed by their exact primary key belong in the B-tree; a row carrying
a geometry blob does not.

**`area_id` is scoped by scenario, and the reason is arithmetic.** The same frontage appears in all
twelve scenario layers with a different distance each time, so the source's `frontageid` is not unique
across the artifact. Twelve layers of roughly 7,400 features each is **89,211 rows** in the truth table
(the remaining 160 of the source's 89,371 are the ground-instability layers, which live in their own
table) and **twelve independent containment indexes** — the cell table is twelve times the size a
single-scenario layer would produce. That is the pilot's real size question, and it is why §4.5 asks for
the measurement per scenario rather than pooled.

`erosion_ground_instability` is a table of its own because it is a different hazard with a different
schema (`local_auth`, `smp_pu1`…`smp_pu5`, `rearscarpr`) and only 160 features. Folding it into the
erosion zones would let a reader answer an erosion question from a landslide polygon.

### 4.4 Manifest fields

| field                       | pilot value                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                      | `coastal-erosion-ea-england`                                                                                                                                              |
| `version`                   | the NCERM edition ingested — `2024`                                                                                                                                       |
| `tier`                      | `shipped` — OGL v3.0 permits redistribution with acknowledgement                                                                                                          |
| `license`                   | the OGL v3.0 identifier                                                                                                                                                   |
| `attribution`               | `© Environment Agency copyright and/or database right 2025. All rights reserved.` — from the structured field, trimmed of its trailing space, **never from the abstract** |
| `source` / `source_vintage` | dataset id `9fede91f-5acd-4fd2-9bd8-98153fa3c2ff` and its publication date 2025-01-28                                                                                     |
| `build_cmd` / `build_sha`   | the invocation and the commit that produced it                                                                                                                            |
| `freshness_policy`          | `versioned-refresh` — ISO maintenance is `annually`, and the EA re-issues under the same product                                                                          |
| `spine_keys`                | `{ h3: { column: "h3_cell", resolution: … } }` — see §1                                                                                                                   |
| `created_at`                | caller-supplied, per the contract                                                                                                                                         |

A USGS-sourced artifact could take `tier: shipped` on its CC0 statement; a NOAA-sourced one could not,
because "as is" and "NOT FOR LEGALLY BINDING APPLICATIONS" is a disclaimer rather than a grant.

### 4.5 The resolution is a measurement the pilot takes

SCOPE invariant 6 asks of anything that looks like it needs a spatial query: is it really a containment
question build time can precompute? An erosion-zone determination is exactly that, so the build converts
the polygons into an H3 containment index and the runtime probes it by key. A cell wholly inside one
zone is answered by the index alone; a cell a boundary crosses names every zone reaching into it, and
the ray-cast against those few candidates is the bounded geometry invariant 6 permits at an irreducibly
geometric edge. `pointInPolygonRings` and `bboxAround` in `@mailwoman/spatial` are the primitives.

**Candidate resolutions: 9, 10 and 11.** H3 average areas, measured locally with h3-js 4.5.0: res 9
105,333 m² (edge 200.8 m), res 10 15,048 m² (edge 75.9 m), res 11 2,150 m² (edge 28.7 m). Res 8 and
coarser are named only to be excluded — a 531 m edge is wider than many English erosion bands, so a
coarse cell would report the band and the land behind it as one answer.

**Expect the `partial` share to be high, and design for that rather than be surprised by it.** NCERM's
zones are narrow strips hugging the coast, so the landward boundary crosses almost every cell it
reaches. This is the soil-delineation geometry rather than the flood-zone geometry: the flood survey
expects `compactCells` to collapse long uniform interiors, and here there are few interiors to collapse.
The ray-cast will be the common path, and that is acceptable because a coastal layer's candidate set per
cell is tiny.

**Two numbers get reported at each candidate, per scenario layer rather than pooled:**

1. **The `partial` cell share** — what fraction of cells a zone boundary crosses. This decides whether
   the index answers a probe alone.
2. **The total cell count across all twelve scenario layers.** The truth tables are fixed at 89,371 rows;
   the cell table is not, and it is the artifact's size.

Two known traps carry over from both sibling surveys, already commented in place in `coverage-region.ts`
and `build-poi.ts`: `polygonToCells` from h3-js takes `[lat, lng]` per vertex in its default
(non-GeoJSON) mode, and a coverage cell must be `cellToParent` of the finer cell rather than a direct
`latLngToCell` at the coarse resolution.

**One reprojection this layer needs and neither sibling did.** NCERM ships in **EPSG:27700**, British
National Grid. H3 takes WGS84 latitude and longitude, so the ingest reprojects — unlike SSURGO, whose
`.prj` reads `GCS_WGS_1984`. `ogr2ogr` is already an external dependency of the TIGER path and handles
it; the point is that the step exists and must be verified rather than assumed, because a silent
identity transform would place England's coast in the North Sea off Africa.

## 5. The outcome — one pilot, one recorded negative finding

### 5.1 The pilot source: England, Environment Agency NCERM National (2024)

Five reasons, in the order they bind.

1. **It is an authority's designation, which is the only thing this layer is allowed to repeat.** The
   USGS compilation is a measurement of past rates — a good one, CC0, and a genuinely different claim
   that would need its own semantics and its own consumer wording. Every EU coastal product is a model,
   a 2004 categorical compilation, or carries a licence contradiction. NCERM is a coastal authority
   stating where erosion risk lies under a named scenario, which is the same object class the flood
   layer carries.
2. **The acquisition path is reachable and was exercised end to end.** 561.9 MB across four formats,
   every byte count matching the platform's own declared size; WFS, WMS and OGC API Features all
   answering; and the feature count agreeing exactly between the service and the file at 89,371. A pilot
   whose first step cannot run is not a pilot.
3. **The licence is verified and permits what a `shipped` layer needs.** OGL v3.0 with a published
   attribution string, `<Fees>NONE</Fees>` on both services, no registration and no key. Compare
   Copernicus (401 anonymous by regulation), ESDAC (redistribution forbidden outright), NOAA (a
   disclaimer, not a grant) and the two EU shoreline products (contradictory licences).
4. **It reuses the flood layer's implementation.** Same platform, same `HEAD` 405 and ignored `Range`, same
   CSW metadata route, same ISO field names, same England extent, same OGL attribution shape. The second
   Environment Agency layer costs a fraction of the first.
5. **It puts the meaning-of-zero rule under a NEW kind of pressure, which is the point.** The flood layer
   taught that absence inside England is a designation. **NCERM inverts that** — absence inside England
   is mostly "not the coast", and the source publishes no way to tell that apart from "coast, and not at
   risk". A builder that generalized the flood rule would produce a well-formed wrong answer over the
   whole country. Meeting that inversion on the second layer, rather than the fifth, is worth the pilot.

The USGS National Shoreline Change compilation stays in the inventory as the natural second layer: CC0,
measured, national in scope, and the first user of §4.2's linear rule. It should not be built in the same
issue, because it answers a different question and needs different consumer wording.

### 5.2 The region

**England, whole.** The bounded region is the product's own extent rather than a sub-region, because the
EA publishes England as one set of files and the layer's identity is that product. The verification
ladder still runs on a smaller area first — see below — but the artifact covers what the authority's
product covers, which keeps the manifest's declared extent and the layer's contents describing the same
set.

### 5.3 The verification ladder

**Fixtures.** Hand-built geometry, no network. A square erosion zone, an adjacent one, one with a hole,
and a narrow strip thinner than one cell. It asserts: a wholly-interior cell resolves from the index
without touching geometry; a boundary cell names every zone reaching into it and the ray-cast runs only
against those; a point outside every polygon produces **no coverage row and no negative claim**, not a
low-risk reading; the twelve scenario layers stay separable and a probe that does not name a scenario is
refused; a zone whose ring is deliberately re-ordered is stored byte-identically to the source rather
than normalized; an undeclared policy or defence code throws rather than being coerced; and a
ground-instability polygon never answers an erosion question.

**Smoke.** One Shoreline Management Plan area from the real geodatabase. This verifies what fixtures
structurally cannot: the actual field names, that the distance column really is named per layer
(`smp2105_95` against `nfi2055_0`), that the reprojection from EPSG:27700 lands where England is, that
the NFI layers really lack the four policy fields, and the seal. The first live poi.db builds caught
three bugs that 800+ green tests missed, all of them source-schema or scale behavior.

**Full.** All 89,371 features across 14 layers, end to end. Memory must stay flat in row count — the poi
build ran out of heap at 13.68 M rows because a reader materialized instead of streaming, and geometry
blobs are heavier per row than POI points. And any coverage insert must be chunked:
`writeLayerCoverage` already batches at `COVERAGE_INSERT_BATCH`, and a builder that hand-rolls its own
insert re-earns SQLite's 32,766 bound-variable ceiling.

**And an agreement check against a second path.** A sample of points from the built artifact, re-asked
of the EA's own WFS or OGC API Features endpoint, with the agreement rate reported. Same authority,
different distribution channel — which is what makes it a check on our conversion rather than on the
authority. The two paths already agree exactly on the feature count, so a disagreement on point-in-zone
is our reprojection or our ray-cast. **Its negative half matters as much:** a sample of inland English
points and a sample of Welsh and Scottish coastal points, confirming the artifact returns **no row**
rather than a low-risk reading.

That last check is the one that would catch the class of defect §3.3 is about, and it is cheap.

### 5.4 The consumer shape

**Which paths may attach it.** The geocode path only, after the resolver has produced a coordinate for
the node the caller asked about. The parse path has no coordinate to ask about.

**Default off, and the switch is the presence of the layer path** rather than a boolean — the shape
`poiSemanticLookup` settled, because a boolean makes the factory construct the reader itself and puts a
layer open on the default construction path. The flag lands with its row in the
[runtime-flag register](../../engineering/reference/runtime-flags.mdx) in the same change; SCOPE
invariant 5 makes a flag with no register row a smell.

**Ranking untouched, and the receipt is byte-stability.** The same query, with and without the layer
attached, returns an identical result plus one advisory. That is a statement about construction — the
carrier reads no candidate, no coordinate and no ordering — and a test pins it.

**What the observation says.** The scenario, horizon and climate allowance it answered under; the
cumulative erosion distance as published; the Shoreline Management Plan policy and its interpretation
where the scenario carries one; the defence type; the product and authority; the edition and its dates;
the containment reading (`whole` cell, or a ray-cast against a named polygon); and the coverage basis,
which in the pilot is `source_present` and therefore licenses no negative claim. Enough for a reader to
re-derive the claim rather than take it.

And the wording carries §3.1's constraint: it reports what the Environment Agency's mapping assigns at
the location under a named scenario, never whether a property will erode — because the Environment
Agency declines that second statement in writing.

### 5.5 The carrier, and the one place it does not fit

`QueryIntentMarker` is the carrier, for the same reasons and with the same reservation both sibling
surveys record. Its contract is already the requirement: additive, attributed, always accompanied by the
ordinary answer, never changing which answer wins, carrying `mechanism` in the `family:rule` form and an
`evidence` record where everything above goes.

The place it does not fit is identical to both siblings', and all three should be settled together
rather than three times: `QueryIntentMarker.kind` names a query kind the verdict carries, and an erosion
observation is not raised by intent at all. `declared_ambiguity` is the precedent for a marker raised at
resolve time rather than by the classifier, but that marker names a kind of its own and this one would
name the verdict's own top kind. Accept that in writing or widen the carrier; picking one is outside a
survey.

### 5.6 The recorded negative finding — no surveyed source supports a soil-erosion layer

This half of the issue closes negative, and the finding is worth as much as the pilot.

**No source surveyed here supports a per-cell claim about soil erosion.** The reasons differ by source
and none of them is fixable by more effort on our side:

- **USDA NRI** — the only US authority that estimates how much soil erosion is occurring, and it
  estimates it for states. The design provides "the equivalent of multi-county level reliability", the
  county tool stops at 2017 and flags its own margins of error, the values are RUSLE2 and WEQ model
  output rather than measurements, wind is measured only in selected states, the land subset is cropland
  and CRP and pastureland only — and above all, **the sample point locations are confidential under
  7 U.S.C. 2276**, so there is no join to a cell to attempt.
- **SSURGO** — per-polygon and reachable and well-licensed, and it is about the wrong thing. K is one of
  six USLE factors; T is a tolerance; the two national interpretations rate a hazard conditional on a
  disturbance that has not happened and exclude gullies, sediment delivery and streambank erosion by
  their own text; the agricultural interpretations are state-authored and not comparable across states;
  `erocl` is NULL on 64.6 % of components; and the special-feature symbols are presence-only in 1,210 of
  3,380 survey areas.
- **ESDAC** — the pan-European products are models, and their terms forbid passing the data to third
  parties. Redistribution is not a judgment call here; it is prohibited in the sentence the user agrees
  to.
- **The one anonymously-downloadable EU soil-erosion product** is 271 NUTS2 polygons carrying a
  region-mean rate, with no licence statement attached to the files at all.
- **The EEA publishes no soil-erosion indicator and no soil-erosion dataset**, established by
  enumerating 546 indicator items and the 3,414-record SDI catalogue rather than by searching.

**What would change this finding**, stated so the negative is falsifiable rather than final:

1. **A national soil-erosion product with released per-location geometry and a redistribution licence.**
   The EU Soil Monitoring Law is the live candidate — it entered into force 2025-12-16 with a three-year
   transposition period, and the Commission mentions a soil health data portal. Re-check when member
   states begin publishing; nothing exists today.
2. **An ESDAC terms change**, or a per-dataset Notification that permits redistribution. The clause is
   per-dataset and ESDAC has no site-wide policy, so this could change for one product without changing
   for the others.
3. **A published NRI product at a finer geography with released geometry.** This is the least likely of
   the three, because the constraint is statutory rather than editorial.
4. **A different question.** If what a consumer wants is the soil's _erodibility_ rather than erosion —
   "is this a soil that erodes easily" — then SSURGO's K factor already answers it at map-unit resolution
   under a good licence, and that would be a **different layer with a different name** carrying §3.2's
   susceptibility wording. It must not be built under the word "erosion", because it does not say
   erosion is happening and a reader would take it as if it did.

## 6. The product requirement

A caller who geocodes an address on a coast where an authority publishes coastal erosion mapping
receives, alongside the ordinary result and without changing it, that authority's own erosion
designation for the resolved coordinate — under an explicitly named management scenario, time horizon
and climate allowance, with the cumulative erosion distance as published, the shoreline management
policy where the scenario carries one, the product and edition it was read from, and the authority's own
dates. Where the authority publishes no determination, the caller receives that fact and receives no
reassuring one: in this first layer the coverage basis licenses presence only, so an absent polygon is
reported as "this product says nothing here" and never as "this location is not at risk", because the
source does not distinguish a location off the coast from a location on the coast outside the risk area.
The observation states what the map assigns at a location under a named scenario and never whether a
property will erode, because the authority itself declines that second statement and says so in the
metadata it publishes. Ranking, abstention and every existing result field are unchanged; the
observation is additive, attributed, and default off.

## 7. The builder-issue outline

Not filed here. The outline, for the issue that lands against this survey:

**Shape.** Following `bdc`: a workspace holds acquisition, parsing and the layer reader; the CLI is thin
wiring. `gazetteer build bdc` takes `--state` as a FIPS code, which is the precedent for a region-scoped
build; the NCERM equivalent takes the edition and an optional Shoreline Management Plan area for the
smoke rung, plus an explicit scenario selector.

**Registration.** A new workspace joins six registers and only the first fails loudly — the root
`workspaces` array, the `.release-it.json` publish list (or a sanctioned-absence entry with the reason as
data), **both** root `tsconfig.json` reference entries, and the `smoke-clean-install.ts` pack set; the
full paragraph, including the bless-package obligation for a brand-new npm name, is in the root
`AGENTS.md`. The arithmetic currently reads **59 workspaces, 53 in the release list, six absent with a
stated reason each** (measured 2026-08-27); re-run it afterwards and confirm every absent name still has
a reason someone can state.

**Acquisition.** The rule binds where it actually draws its line. Metadata reads, the CSW record and
per-feature WFS queries are API requests and go through `APIClient`; a 70 MB geodatabase archive
streamed to disk is a file transfer and keeps raw `fetch`, saying so in place, as `osm/sdk/fetch.ts` and
`tiger/sdk/download.ts` do. Three behaviors to write into the client: the host answers `HEAD` with 405
and **ignores `Range`**, so freshness cannot be probed by content length; **the OGC service slug is
`ncern`, not `ncerm`**, and the correct spelling returns 404; and the attribution string comes from the
record's structured licence field, because the abstract's copy is doubled and the first copy carries no
year.

**Build.** Ingest the geodatabase with `ogr2ogr`, **reprojecting EPSG:27700 to WGS84** and asserting the
result lands inside the EA's declared bounding box. Build `erosion_zone_area` with precomputed bounding
boxes and unsimplified rings as the truth, scoping `area_id` by scenario. Keep the two ground-instability
layers in their own table. Polyfill each zone to the candidate resolutions and record `whole` or
`partial` per cell. **Write `layer_coverage` at `basis = source_present` and no negative claim** until
§3.3's footprint question is settled — and write a test that fails if any code path reads
`supportsExclusion` as true for this layer. Write the manifest; seal 0444; build-then-swap.

**Do not put a raster in the database**, and do not build a linear layer with the polygon rule. §4.2 has
the third shape for whichever comes next.

**Measure and report** the `partial` cell share and the total cell count at res 9, 10 and 11, **per
scenario layer rather than pooled** (§4.5), and pick from the measurement. Expect the `partial` share to
be high and `compactCells` to yield little.

**Verify** on the fixtures → smoke → full ladder in §5.3, ending with the two-path agreement check and
its negative half.

**Wire** the observation per §5.4/§5.5, default off, with its runtime-flag register row, and a
byte-stability test with the layer absent.

**Settle in writing** the three questions §1 leaves open: the mapped-footprint source (which is what
would move this layer from `source_present` to `designated`), the spine-key declaration for a
polygon-derived cell layer, and whether the advisory code extends the query-intent vocabulary or widens
the carrier. The last two are shared with both sibling surveys and should be answered once for all
three.

**Do not** build the USGS shoreline layer in the same issue. It is a rate rather than a designation, it
is the first user of the linear rule, and its consumer wording differs.

## 8. What could not be verified

Recorded as gaps rather than filled in. Nothing below was completed with a plausible reading.

**Environment.**

- **`eur-lex.europa.eu` is unreachable from this lab.** Three curl attempts at 20 s, 40 s and 90 s each
  returned 0 bytes; two WebFetch attempts timed out at 60 s. Consequently **Directive (EU) 2025/2360's
  own text was not read** — the transposition article and date, whether an annex names soil erosion as a
  descriptor with a unit and a methodology, and the first-measurement deadline are all unknown. What is
  established from the Commission's news page is that the law is in force and produces no published EU
  erosion dataset today.
- **`www.usgs.gov` is behind an AWS WAF JavaScript challenge**, so the USGS National Shoreline Change
  data-publication catalogue page was never read. Plain curl returns 403; a full browser header set
  returns 202 with the challenge page; WebFetch returned empty twice. Mitigated rather than left open:
  the releases were enumerated from ScienceBase's item API and from the compilation's own `webLinks`
  block, both primary.
- **`catalog.data.gov`'s CKAN API is gone** — `/api/3/action/package_search` and
  `/api/3/action/status_show` both return HTTP 404. Individual dataset pages still serve. No data.gov NRI
  record could be confirmed to exist either way, and the usa.gov redirect finding makes that field
  non-authoritative regardless.
- **`www.nrcs.usda.gov` requires the full browser header set including `Sec-Fetch-User: ?1` and
  `Upgrade-Insecure-Requests: 1`.** Without them the host hangs (HTTP/1.1: exit 28, 0 bytes after 80 s)
  or resets mid-stream (HTTP/2: exit 92, `INTERNAL_ERROR`, 0 bytes at 0.03 s). The failure looks like a
  dead host and is not one.

**The pilot's open question.**

- **The English coastal mapped footprint.** Neither candidate source in §3.3 was verified. The EA's
  Shoreline Management Plan Mapping record was observed to exist with four spatial formats plus a `.lyr`
  file; its coverage statement, licence, extent and schema were not read. Whether the frontage geometry
  behind `frontageid` is published at all was not established. **This is the single fact that would move
  the pilot from `source_present` to `designated`, and it is the first thing the builder issue should
  settle.**
- **The 16 anomalous NCERM rows per layer** (blank policy and defence fields, `published = 0`). Their
  existence is measured; the EA documents no meaning for them.
- **Whether a GOV.UK public erosion checker exists.** `https://www.gov.uk/check-coastal-erosion-risk`
  returns 404; the two live flood-checking services were not driven through a postcode to see whether
  erosion is surfaced there.

**United States.**

- **NRCS's own prose definition of `erocl` classes 1–4.** `mdstabcol` and `mdstatdomdet` are not exposed
  through SDA ("Invalid object name"); the Tables and Columns Report
  (`https://sdmdataaccess.nrcs.usda.gov/documents/TablesAndColumnsReport.pdf`, HTTP 200, 2,036,499
  bytes) lists the column as a Choice over domain `erosion_class` and carries no domain detail; and the
  National Soil Survey Handbook page exposed no part links to a plain parse. The measured domain is
  reported; the definitions are not.
- **A national count of components carrying the two national forestry erosion interpretations.** The
  whole-table aggregate exceeded SDA's server-side timeout (HTTP 400, `ServiceExceptionReport`, "Your
  query timed out.", 90.6 s). Five survey areas were measured instead — `IA153`, `TX299`, `CA630`,
  `AK655`, `FL001` — and every component in each carried the rule. That is evidence of national coverage,
  not a national figure.
- **The USGS ScienceBase `ptvctcnt` disagreement** — 126,831 declared against 133,113 measured. The
  measured number is reported and the metadata flagged stale; why they differ was not established.
- **NOAA's per-class C-CAP accuracy statements and its own site-specific-use caveat.** Not retrieved. No
  C-CAP-derived observation may ship before they are.
- **The CVI ArcGIS REST service** — unreachable (port 443 refuses TCP), so its service metadata could not
  be read. Its content is covered by the DDS-68 archive and the portal's WFS, both measured.
- **Whether any state publishes a county-level NRI erosion summary.** One search only; not established
  either way.

**EU.**

- **The licence on ESDAC's NUTS-aggregated indicator files.** They serve anonymously with no terms
  attached, and ESDAC has no site-wide policy page (22 candidate URLs across this survey and its sibling,
  all 404). Unresolved rather than permissive.
- **The `geossNonCommercial` versus CC BY 4.0 conflict** on the JRC global shoreline dataset. Both
  statements sit in the same distribution folder; no third document resolving them was found.
- **EMODnet's CC-BY versus CC BY-SA conflict.** The portal terms page states CC-BY 4.0 only;
  `…/en/terms-use` returns **403**, so a qualifying statement may exist behind it. The operative reading
  for anything carried is share-alike, and that is a counsel question.
- **Per-country provenance in EMODnet field data.** The layer has no country attribute and the ISO record
  names only a point of contact. Contributor blocks are visible in the stratified sample and unlabelled.
- **The EUROSION `DOCUMENTATION/` folder**, including `d2134 data_access_conditions_v2.0.pdf` (468,824
  bytes). Listed but not read. It is the one document that could qualify the acknowledgement-only
  wording.
- **The Copernicus Coastal Zones prepackaged files** (2 GB geodatabase, 3 GB GeoPackage). The download
  API answers 401 anonymously and no registration was performed.

**Measurement traps found while running this survey.** Five, all of the shape this repository keeps
writing down — a false negative indistinguishable from a real absence — and each caught by a second path:

1. A CSW constraint of `AnyText like '%erosion%'` returns HTTP 200 and **2** records; the wildcard-free
   `AnyText like 'erosion'` returns **15**. The `%` is matched literally against a tokenized field, and
   the two-record answer looks complete.
2. An EMODnet request carrying `propertyName=…` reported four columns as 100 % null. That was the
   projection dropping the columns; a re-fetch with no projection returned real values. Every class
   figure in §2.8 comes from the unprojected read.
3. Reading the head of the EMODnet field-data layer reports **85.0 %** unusable; a stratified read over
   20 offsets reports **23.8 %**. The head was one contributor's block.
4. Northern Ireland's erosion record shows **0 resources** on data.gov.uk and carries GeoJSON and
   shapefile on OpenDataNI — a harvest gap, not an absence. Those files then return **403 to a plain
   curl and 200 with a browser User-Agent**, a second false negative on top of the first. Three further
   NI records showing zero resources were **not** followed through, and their zeros must not be read as
   absences.
5. An unscoped `?q=erosion` against the LandIS portal returned 10 hits, all of them global federated
   results from other countries; the organisation-scoped query returned **zero**. The unscoped answer
   would have reported a product that does not exist.
