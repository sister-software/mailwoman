# Flood-zone risk as a spatial layer — source survey and pilot design

Design record for #1983. A survey, not a builder: it settles which authorities publish flood-hazard
data we could carry, what each one's own words permit and forbid, what a layer built from one would
be allowed to claim, and which single source and region the first build should take. The builder is a
follow-up issue, outlined in §7 and not filed here.

The consuming machinery already exists, so nothing below proposes new architecture. The layer
contract (`layer_manifest` / `layer_coverage` on the H3 spine) is specified in
[`../../engineering/reference/layer-contract.mdx`](../../engineering/reference/layer-contract.mdx);
`packages/bdc` is the worked federal-provider shape; the exclusion-grade coverage pilot
([`2026-08-27-exclusion-grade-coverage-pilot.md`](./2026-08-27-exclusion-grade-coverage-pilot.md), PR
#1973) is the basis discipline; and the observation carrier that shipped with PR #1979 delivers an
additive, provenance-carrying advisory without touching ranking. What was missing was source
knowledge. This record is that.

**Every external claim below carries its URL and the date it was read.** Where a fact could not be
established from a primary source it is in §8 as unverified, with what was tried. Nothing in §8 was
filled in with a plausible reading.

## 1. What this record settles, and what it deliberately does not

Settled here: the verified inventory (§2), what each source's own coverage statement licenses a
`layer_coverage` row to say (§3), the schema shape a flood layer takes under the existing contract
(§4), the pilot's source, region, verification ladder and consumer shape (§5), and the product
requirement (§6).

Not settled here, and named so nobody reads silence as a decision: the H3 resolution the containment
index is built at (§4.4 — it is a measurement the pilot takes, not a choice this record makes); the
spine-key declaration for a polygon layer (§4.5 — the contract has met this shape before and the
answer is the builder's); whether the observation's advisory code extends the existing query-intent
vocabulary or widens the carrier (§5.5); and any distribution decision for a FEMA-derived artifact,
which §2.2 shows rests on a license statement FEMA does not publish.

Out of scope by the issue and kept out: any ranking or abstention change, and any non-authoritative
risk modeling. The layer records what an authority states, in the authority's vocabulary, with the
authority's dates. It computes no score of its own.

## 2. Source inventory

### 2.1 England — Environment Agency, "Flood Map for Planning - Flood Zones"

All facts in this section read **2026-08-27**.

The current product is
[**Flood Map for Planning - Flood Zones**](https://environment.data.gov.uk/dataset/04532375-a198-476e-985e-0579a0a11b47)
([data.gov.uk record](https://www.data.gov.uk/dataset/104434b0-5263-4c90-9b1e-e43b1d57c750/flood-map-for-planning-flood-zones1)).
ISO metadata dates: creation 2025-01-29, publication 2025-03-25, revision 2026-05-20.

**The product name in the issue is out of date, and the old datasets are gone.** The standalone
[Flood Zone 2](https://environment.data.gov.uk/dataset/86ec354f-d465-11e4-b09e-f0def148f590) and
[Flood Zone 3](https://environment.data.gov.uk/dataset/87446770-d465-11e4-b09e-f0def148f590) records
both carry a retirement notice pointing at the replacement, and the retirement is real rather than
announced: a `package_show` query against the data.gov.uk CKAN API returns three resources each — a
`Data Version.txt`, a `.lyr` layer file, and a guidance PDF. **No spatial data remains on either
record.** A builder written against the old dataset ids would find files that are not the data.

Two zones in one layer, and the EA's FAQ
([environment.data.gov.uk/support/faqs/778338325](https://environment.data.gov.uk/support/faqs/778338325))
states the lineage and one behavioral change that matters to a consumer:

> "From 25 March 2025, the Flood Zones are produced as part of the new National Flood Risk Assessment
> (NaFRA2)."

> "Flood Zones 2 and 3 will no longer overlap, with clear attribution between the Flood Zones."

A reader that previously treated Zone 2 as containing Zone 3 is wrong against the current data.

**Schema.** Layer `Flood_Zones_2_3_Rivers_and_Sea`, polygon geometry, five columns: `OBJECTID`,
`Shape`, `Origin` ("Source of data (modelled, recorded, direct rainfall model, local evidence)"),
`Flood_zone` ("Assigned Flood Zone (Flood Zone 2 or 3)"), `Flood_source` ("river and/or sea and/or
undefined"). A WFS `resultType=hits` request returns `numberMatched="813627"`.

**License — OGL v3.0, verified.** The ISO metadata's `gmd:useLimitation` is "Open Government
Licence" and its `gmd:otherConstraints` is "There are no public access constraints to this data. Use
of this data is subject to the licence identified." The data.gov.uk record names
[the OGL v3.0 text](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). The
required attribution string is given in the metadata:

> "© Environment Agency copyright and/or database right 2025. All rights reserved."

OGL v3.0 requires that a re-user

> "acknowledge the source of the Information in your product or application by including or linking
> to any attribution statement specified by the Information Provider(s) and, where possible, provide
> a link to this licence"

The WFS `GetCapabilities` reports `<ows:Fees>NONE`. This is a license that permits redistribution
with a named acknowledgement — the posture that makes a `shipped` layer possible.

**Acquisition — direct whole-England file URLs, sizes measured by GET.** The download base is
`https://environment.data.gov.uk/api/file/download?fileDataSetId=455d2eb3-3065-4d20-871b-c4d5dee23f67&fileName=…`:

| format               | file name                                        |         bytes |
| -------------------- | ------------------------------------------------ | ------------: |
| File geodatabase zip | `Flood_Map_for_Planning_Flood_Zones.gdb.zip`     |   366,897,893 |
| GeoPackage zip       | `Flood_Map_for_Planning_Flood_Zones.gpkg.zip`    |   969,511,188 |
| GeoJSON zip          | `Flood_Map_for_Planning_Flood_Zones.geojson.zip` | 4,490,553,481 |

One acquisition detail with a cost attached: the server answers `HEAD` with HTTP 405 and ignores
`Range` (it returns 200 with the full length), so a size probe starts a real download. A builder
cannot cheaply check freshness by content length alone.

Services: WFS 2.0.0 at
`https://environment.data.gov.uk/spatialdata/flood-map-for-planning-flood-zones/wfs` (layer
`dataset-04532375-a198-476e-985e-0579a0a11b47:Flood_Zones_2_3_Rivers_and_Sea`), WMS at `…/wms`, OGC
API Features at `…/ogc/features/v1`. Advertised WFS output formats include `GEOJSON`, `Geopackage`,
`csv`, `KML`, `gml3`, `gml32`.

**Cadence.** ISO `MD_MaintenanceFrequencyCode` is `asNeeded` on every current EA flood dataset
checked — there is no fixed schedule in the metadata. The product description (published 30/06/2026)
states an intent rather than a commitment:

> "In the future we plan to publish the data every three months and update it in locations where new
> local flood model information is available. Ahead of this, flood risk updates will be less frequent
> as our new processes are established."

**Sibling products, current but not bulk-downloadable.** Risk of Flooding from Rivers and Sea
([RoFRS](https://environment.data.gov.uk/dataset/96ab4342-82c1-4095-87f1-0082e8d84ef1), publication
2025-01-28, revision 2026-06-18, 2 m grid with retained 50 m legacy areas) and Risk of Flooding from
Surface Water ([RoFSW](https://environment.data.gov.uk/dataset/b5aaa28d-6eb9-460e-8d6f-43caa71fbe0e),
revision 2025-09-17) are the NaFRA2 likelihood products. Enumerated through CKAN, each exposes only a
product-description PDF, a layer file, a WMS endpoint, and a resource named "Download data by area of
interest and format" pointing at `https://environment.data.gov.uk/explore/{id}?download=true`. **No
WFS, no OGC API Features, no direct file URL.** An unattended bulk pull is available for the Flood
Zones and not for these. On 2026-05-28 the EA published four Surface Water Spatial Planning datasets
that superseded RoFSW _for planning use_; the older product stays available but "should no longer be
used for planning decisions" (same FAQ).

**Other UK nations are different authorities with different schemes**, and none of their terms were
verified here: Wales — [Natural Resources Wales](https://naturalresources.wales/flooding/flood-map-for-planning/),
a four-zone scheme under TAN15 that is not interchangeable with England's; Scotland —
[SEPA](https://map.sepa.org.uk/floodmaps), downloads at
[www2.sepa.org.uk/flooddata](https://www2.sepa.org.uk/flooddata/); Northern Ireland —
[DfI Rivers](https://www.infrastructure-ni.gov.uk/articles/how-flood-maps-ni-was-produced), whose
page states the same 3 km² catchment floor England uses.

### 2.2 United States — FEMA National Flood Hazard Layer

All facts in this section read **2026-08-27**.

**Retrieval obstacle, stated first because it changes the pilot decision.** `hazards.fema.gov`,
`msc.fema.gov` and `floodmaps.fema.gov` accept a TCP connection on 443 from this network and then
reset the TLS handshake. Reproduced with both curl and a real Chromium against both DNSSEC-validated
addresses (18.253.155.176 and 182.30.81.39; Cloudflare and Google DoH agree, `AD=true`), so it is not
a resolution failure — the behavior is consistent with a geographic block. Separately, `www.fema.gov`
answers non-browser clients with HTTP 403. **Every FEMA fact below was therefore obtained through a
real browser, an Internet Archive capture of FEMA's own URL, a US-egress reader proxy, or a named
non-FEMA mirror**, and each is labeled as such in the source notes. The distribution endpoints an
ingest would call are, today, unreachable from here.

**License — there is no public-domain statement, and that is a checked absence.** The issue expected
public domain. FEMA does not say it. The canonical FGDC metadata
(`https://hazards.fema.gov/filedownload/metadata/NFHL/NFHL_metadata.xml`, read from a
[Wayback capture](http://web.archive.org/web/20250331193111id_/https://hazards.fema.gov/filedownload/metadata/NFHL/NFHL_metadata.xml)
and corroborated byte-for-byte by the State of Hawaii's June-2026 MSC-sourced mirror at
[files.hawaii.gov](https://files.hawaii.gov/dbedt/op/gis/data/s_fld_haz_ar_state.html); a Wayback CDX
`collapse=digest` query returns a single content digest across all captures) carries access
constraints of exactly "None" and this complete use-constraints text:

> "The hardcopy FIRM and FIRM Database and the accompanying FIS are the official designation of SFHAs
> and Base Flood Elevations (BFEs) for the NFIP. For the purposes of the NFIP, changes to the flood
> risk information published by FEMA may only be performed by FEMA and through the mechanisms
> established in the NFIP regulations (44 CFR Parts 59-78). These digital data are produced in
> conjunction with the hardcopy FIRMs and generally match the hardcopy map exactly. Acknowledgement
> of FEMA would be appreciated in products derived from these data."

That is an acknowledgement _request_, plus a restriction on who may change NFIP flood-risk
information. It is not a license grant and it is not a redistribution restriction. Distribution
liability, same record: "No warranty expressed or implied is made by FEMA regarding the utility of
the data on any other system nor shall the act of distribution constitute any such warranty."

The nearest artifacts to a license are (a) the FEMA-published data.gov entry
[catalog.data.gov/dataset/national-flood-hazard-layer](https://catalog.data.gov/dataset/national-flood-hazard-layer)
(identifier `FEMA-0145`, modified 2025-04-01), whose JSON-LD sets
`"license": "https://www.usa.gov/government-works"` with `rights: null` — while that URL redirects to
[usa.gov/government-copyright](https://www.usa.gov/government-copyright), which declines a blanket
grant ("Not everything that appears on a federal government website is a government work… Check with
the federal agency"); and (b) FEMA's site-wide
[website-information](https://www.fema.gov/about/website-information) page (updated May 1, 2023),
"Most material on FEMA.gov is free of copyright and may be copied and distributed without
permission", which covers website content and does not name NFHL data. A **second** data.gov entry
carrying the same license field is published by HIFLD, not FEMA, and must not be cited as FEMA's.

**The "unofficial copy" premise inverts.** No FEMA statement calls the NFHL unofficial or
informational-only. FEMA Policy #204-078-1 Rev 13, _Standards for Flood Risk Analysis and Mapping_,
SID 605 (effective 2014-11-30; read from the
[Idaho State University mirror](https://giscenter.isu.edu/pdf/PDF_FEMA_DOS/fema_policy-standards-flood-risk-analysis-mapping-rev-13.pdf)
because fema.gov's copy refuses non-browser clients) says the opposite:

> "Flood Insurance Rate Maps, FIRMettes, and NFHL Databases are the official FEMA digital products.
> The official FEMA digital products and printed versions produced from the official digital products
> are all equivalent to each other and represent official FEMA designations of the areas of special
> flood hazard, base flood elevations, insurance risk zones and other regulatory information,
> provided that all other geospatial data shown on the printed product meets or exceeds any accuracy
> standard promulgated by FEMA."

The conditional attaches to the base map a product is combined with, not to the NFHL. The one genuine
use restriction is on **preliminary and pending** data, which "cannot be used to rate flood insurance
policies or enforce the Federal mandatory purchase requirement" (NFHL GIS Services guide), and on
printed exports covering unmapped areas.

**Extent and the digital/paper split.** FEMA states digital coverage of "over 90 percent of the U.S.
population" on the [NFHL page](https://www.fema.gov/flood-maps/national-flood-hazard-layer) (updated
2025-04-03), and its EMI course IS-0273 is blunter:

> "NFHL digital data coverage is not nationwide but it covers over 90 percent of the U.S.
> population."

A separate and larger figure covers the _whole_ mapping inventory including paper: the April 2026
[Notice to Congress](https://www.fema.gov/sites/default/files/documents/fema_rsl_notice-congress_042026.pdf)
reports "approximately 1.3 million miles of flooding sources (riverine and coastal) which covers
communities that make up 98% of the U.S. population", against "1.2 million unmapped miles" and "1.1
million miles on Federal Lands and do not need to be mapped". The two population figures measure
different objects and come from documents with no shared stated denominator; they must not be
subtracted from one another.

A parse of FEMA's live download inventory (`https://hazards.fema.gov/femaportal/NFHL/searchResult`,
read through the proxy) counted **2,670 NFHL database entries** — 2,504 countywide plus 166
single-jurisdiction, across 56 states and territories, per-entry update dates 2000-01-19 to
2026-08-10, ~88.9 GB total, median 18 MB, maximum 776 MB. Four independent token counts over the same
page agree at 2,670. That is a measurement of the digital side, not a FEMA-published coverage
statistic, and it has no stated denominator.

**A count of communities on paper-only or unmodernized maps was not found** (§8).

**Formats and acquisition.** County and community extracts are shapefile-in-zip; state extracts are a
file geodatabase in zip (per the University of New Hampshire GRANIT clearinghouse's
[instructions](https://granitweb.sr.unh.edu/MetadataForViewers/CommonViewers/RelatedDocuments/floodDownloadInstructions.pdf),
corroborated by FEMA's own MSC naming). The direct-download pattern, from FEMA's own
[factsheet](https://msc.fema.gov/msccontent/FEMA_Hazard_Products_Direct_Download.pdf):

> "The standard direct download format contains two parts: the static prefix and the Product ID… An
> example full URL is: https://msc.fema.gov/portal/downloadProduct?productID=NFHL_51013C"

so `NFHL_<5-digit-FIPS>C` for a county and `NFHL_<6-digit-CID>` for a community. The statewide
productID pattern is not documented in that factsheet (§8).

Services: ArcGIS REST at `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer`, WMS
at `…/public/NFHLWMS/MapServer/WMSServer`, WFS at
`https://hazards.fema.gov/arcgis/services/public/NFHL/MapServer/WFSServer`. The live service
definition reports `maxRecordCount` 2000, `supportedQueryFormats` `JSON, geoJSON, PBF`,
`spatialReference` wkid 4269 (NAD83), and **empty strings for `serviceDescription`, `description` and
`copyrightText`** — the service carries no attribution or license text at all. The WFS caps a request
at 1,000 features, in FEMA's own wording: "Requests are currently limits to 1000 features, so it is
recommended that users focus on a very limited area of interest when requesting data through WFS." No
rate limit, quota, or API key is published for the NFHL services or MSC downloads.

One documented trap: FEMA's published GIS Services guide numbers layers differently from the live
service, read the same day — the guide lists LOMAs at 2 and a layer 21 that the live service does not
have, while the live service serves LOMAs at 34. **Bind to layer names, not to the guide's ids.**
`S_Fld_Haz_Ar` is layer 28 ("Flood Hazard Zones"); `S_FIRM_Pan` is layer 3 ("FIRM Panels"); the
NFHL availability polygons are layer 0.

**Cadence.** The metadata's maintenance frequency is "Monthly", describing the per-state distribution
sets ("It is updated on a monthly basis"), while the underlying layer is "Continuously updated" — two
statements about two objects, not a contradiction. Currency is per-distribution-set: "Each State or
Territory data set consists of all FIRM Databases and corresponding LOMRs available on the
publication date of the data set." A county update is a **wholesale replacement keyed on
`DFIRM_ID`**, not a patch — Guidance Document 12 (February 2019) §7.0 describes removing all layers
for a `DFIRM_ID` and replicating the new ones, and _Standards for Flood Risk Projects_ (Nov 2016) SID
610 requires that "the NFHL must replace all data for a submitted dataset (i.e. DFIRM_ID) in its
entirety". Anyone diffing two NFHL vintages is diffing whole jurisdictions.

### 2.3 EU level — the central repository of member-state flood maps does not exist

All facts in this section read **2026-08-27**. This is the section where a plausible guess would have
been wrong, so the finding is stated as what it is: the thing an EU row in this inventory would
naturally be — a merged, downloadable set of the member states' own flood hazard maps — **does not
exist, and the reporting rule forbids it.** The _Floods Directive GIS Guidance_ v1.4
([cdr.eionet.europa.eu](https://cdr.eionet.europa.eu/help/Floods/Floods_2018/GuidanceDocuments/Floods_GISGuidance.pdf),
p. 9), verbatim:

> "The Flood Hazard and Risk Maps spatial data sets must be provided in the national INSPIRE
> Geoportals. The Flood Hazard and Risk Maps spatial data sets must not be reported to Reportnet's
> CDR."

What member states report centrally is **links**. The `GML_FHRM_LinkToMS.xsd` schema
([dd.eionet.europa.eu](https://dd.eionet.europa.eu/schemas/Floods/GML_FHRM_LinkToMS.xsd)) carries
`ServiceURL` children (`wfs`, `wms`, `portal`, `pdf`, `other`) and **no geometry element at all**;
the Netherlands' entire Article 6 spatial delivery is a 21 KB XML of links. Reportnet 3's public
spatial exports write `<<GEOMETRIES ARE NOT EXPORTED>>` into every geometry cell. The
[EU Flood Risk Areas Viewer](https://discomap.eea.europa.eu/floodsviewer/) serves four layers — units
of management plus areas of potential significant flood risk as point, line and polygon — and no
hazard extents; the Commission describes it as "a single gateway to all Member States' preliminary
flood risk assessments, flood hazard and risk maps, and flood risk management plans in the national
language/s", which is a gateway of links. And the
**INSPIRE Geoportal, the route the guidance points at, is retired** — data.europa.eu states "the
INSPIRE Geoportal will be retired on 1 July 2026", and its successor is a metadata catalogue of
national service endpoints in many schemas, projections, languages and licenses, not a merged layer.

**What is centrally downloadable is one dataset, and it is not hazard extents.** "Floods Reference
Spatial Datasets reported under Floods Directive — version 3.0, Mar. 2025"
([EEA SDI record `f0606e9f-0ce2-4c1b-93b0-0af0ce0725e4`](https://sdi.eea.europa.eu/catalogue/srv/api/records/f0606e9f-0ce2-4c1b-93b0-0af0ce0725e4);
the v2.0 record is superseded) is a 1,455,656,960-byte GeoPackage in EPSG:4326 holding 330,523 APSFR
polygons, 1,209 points and 3,330 lines. Its attribute schema has **no depth, no return period and no
scenario**. Two further traps measured on the file itself: despite the "Mar. 2025" title its contents
are 2nd-cycle data (`cYear` 2018 for 330,462 rows), and the units-of-management layer its own abstract
promises is not in the file. License: "License CC-BY 4.0… Copyright holder: European Environment
Agency (EEA)" with "no limitations to public access"; no DOI.

**The EU-level products that do carry flood hazard are modeled, not designated.** The JRC river flood
hazard maps for Europe are published at 3 arc-seconds (≈ 90 m) over nine return periods under CC BY
4.0, DOI `10.2905/1D128B6C-A4EE-4858-9E34-6210707F3C81`; the global equivalent is 3 arc-seconds
current with a 30 arc-second legacy edition, DOI `10.2905/JRC.VD32YWG`. Copernicus Land Monitoring
carries no standing pan-European flood hazard product, and Copernicus Emergency Management's
on-demand mapping is activation-driven — a response to an actual event, not a standing hazard layer.

**Why none of this becomes the pilot, and it is not the resolution.** These are pan-European
_models_, not any authority's designation of a location, so they fall outside what §3.1 says this
layer is allowed to report and inside what the issue puts out of scope. Two published statements make
the point without needing the resolution argument. The viewer's own about-panel: "Member States define
what constitutes a potentially significant flood risk depending on their particular circumstances and
flood risk management approaches… **Direct comparisons between Member States are therefore not
advisable.**" And the reference dataset's declared equivalent scale is 1:100,000, with the GIS
guidance recommending "positional accuracy acceptable for cartographic representation at the
1:100.000 scale or larger". A search across the WISE page, the viewer configuration, all four EEA SDI
Floods records, the EEA data policy, both guidance documents and the Commission pages found **no**
literal property-level-use caveat — that absence was checked rather than assumed, and the scale
recommendation plus the comparability warning plus the EEA's "as is" clause are the closest primary
statements.

The practical consequence for this program: **a European flood layer is built country by country from
each member state's own maps**, reached through the link register, and England is the first of those.
There is no central shortcut.

### 2.4 Deliberately not surveyed

- **Member-state flood maps outside England** (France, Germany, and the rest). Each state publishes
  its own maps under its own terms; none were verified here, and none is claimed.
- **Modeled risk products that are not an authority's designation** — the issue puts non-authoritative
  risk modeling out of scope, and this record keeps it out. The layer's whole value is that it repeats
  an authority; a modeled score would be a different product with different obligations.

### 2.5 The inventory, side by side

|                         | **EA — Flood Map for Planning: Flood Zones**                         | **FEMA — National Flood Hazard Layer**                                                                                                                             | **EU level**                                                                       |
| ----------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| authority               | Environment Agency (England)                                         | FEMA (US)                                                                                                                                                          | none — member states are the authorities                                           |
| what it is              | an authority's designation                                           | an authority's designation                                                                                                                                         | a link register, plus JRC models                                                   |
| license                 | **OGL v3.0**, verified in ISO metadata; attribution string published | **No license grant published.** Access constraints "None"; acknowledgement "would be appreciated"; data.gov carries `usa.gov/government-works` with `rights: null` | reference dataset CC BY 4.0, no DOI; JRC maps CC BY 4.0 with DOIs                  |
| extent                  | England only; ISO bbox 49.943–55.816 N, −6.236–2.072 E               | Not nationwide. ">90% of U.S. population" digital; 2,670 county/community databases measured                                                                       | EU-wide for the models; **no central hazard extents at all**                       |
| vocabulary              | Flood Zone 2, Flood Zone 3 (Zone 1 = absence)                        | 13 `FLD_ZONE` codes + 35 `ZONE_SUBTY` codes                                                                                                                        | none — the reference dataset has no depth, return period or scenario               |
| vintage                 | pub 2025-03-25, rev 2026-05-20                                       | per-jurisdiction; measured update dates 2000-01-19 → 2026-08-10                                                                                                    | "Mar. 2025" title over 2018-cycle contents                                         |
| cadence                 | ISO `asNeeded`; three-month publication stated as intent             | monthly state sets; continuous underlying layer; wholesale `DFIRM_ID` replacement                                                                                  | six-year reporting cycles; 3rd cycle due 2026-03-22, 12 of 27 states public        |
| format                  | GDB 367 MB · GPKG 970 MB · GeoJSON 4.49 GB (measured)                | county/community shapefile zip; state file-geodatabase zip; ~88.9 GB total, median 18 MB                                                                           | GeoPackage 1.36 GiB (measured); JRC rasters at 3 arc-seconds                       |
| acquisition             | direct file URL + WFS + OGC API Features                             | `downloadProduct?productID=NFHL_…`; ArcGIS REST / WMS / WFS                                                                                                        | anonymous HTTP for the reference dataset; per-country national endpoints otherwise |
| reachable from this lab | **yes** — sizes measured by GET                                      | **no** — TLS reset on all three distribution hosts                                                                                                                 | yes                                                                                |
| usable for this layer   | **yes — the pilot**                                                  | yes, once acquisition and distribution are settled                                                                                                                 | **no** — models, not designations, and explicitly not comparable across states     |

## 3. Coverage honesty per source

The failure this section exists to prevent is the one #1964 closed for POIs: an unmapped area reading
as a safe one. For flood data that failure is worse than for pharmacies, because the absence of a
hazard polygon is exactly what a reader wants to interpret, and both authorities publish an explicit
warning against interpreting it loosely.

### 3.1 The claim a coverage row is allowed to make

`CoverageBasis.Designated` means "An authority declares the set complete for this cell". The set both
authorities declare complete is **their own designation**, not the world's flood risk. So the strongest
negative claim a flood layer can support is:

> the authority's effective map assigns no hazard designation at this location

and never

> this location will not flood.

Both authorities say the second reading is wrong, in their own words. FEMA, on
[fema.gov/flood-maps](https://www.fema.gov/flood-maps) (updated January 22, 2024):

> "There is no such thing as a 'no-risk zone,' but some areas have a lower or moderate risk."

The Environment Agency, in the Flood Zones product description (published 30/06/2026):

> "It is important to note that not all rivers are included in the maps and, if a development is to
> take place near one of these rivers, further investigations and modelling may be required. In these
> locations it should therefore not be assumed that there is no flood risk. Flood Zones are a planning
> tool and they do not necessarily mean somewhere will or will not flood."

> "The Flood Zone datasets are designed to only give an indication of flood risk from rivers and the
> sea to an area of land and are not suitable for showing whether an individual property is at risk of
> flooding. This is because we cannot know all the details about each property."

That second quotation is the sharpest constraint in this record. The pilot resolves addresses; the
authority says its map is not suitable for a property-level determination. The layer therefore reports
**which zone the authority's map assigns to the location**, which is a fact about the map, and never
**whether the property is at risk**, which the authority declines to state. The distinction has to
survive into the observation's wording, not only into this document.

### 3.2 England — what is mapped, what is not, and the basis it supports

The EA publishes a coverage statement, which is what makes `designated` reachable at all:

> "The mapping of Flood Zone datasets covers all of England, down to catchments with an area of 3km2.
> Where we have suitable data for smaller catchments, we will also show this."

And the Planning Practice Guidance defines Zone 1 as the absence itself
([gov.uk/guidance/flood-risk-and-coastal-change](https://www.gov.uk/guidance/flood-risk-and-coastal-change),
Table 1, Paragraph 078, Reference ID 7-078-20220825):

> **Zone 1 Low Probability** — "Land having a less than 0.1% annual probability of river or sea
> flooding. (Shown as 'clear' on the Flood Map for Planning – all land outside Zones 2, 3a and 3b)"

So inside England, a location with no polygon is not unsurveyed; it is Zone 1 by the authority's own
definition. That is the storable form of a designated absence, and it is what the coverage row is for.

**The basis this supports:** `designated`, `completeness = 1.0`, for every cell inside England — with
the class boundary carried by the layer's identity rather than by the completeness number. The set
declared complete is _Flood Zone 2 and 3 from rivers and the sea, for catchments of 3 km² and above_.
A catchment below that floor is outside the class, the same way a parapharmacie was outside the
pharmacy class in the #1964 pilot; a class boundary is not incompleteness, and encoding it as a
fractional completeness would invent a measurement nobody took.

That reasoning only holds if the layer cannot be read as covering a class it does not hold, and the
contract has already met this problem. `absence-route.ts` records it plainly — a coverage table
carries a completeness per cell and no class, so a completeness measured over pharmacies would license
a claim about cafés if nothing stopped it — and solves it by reading the held class out of the artifact
and refusing unless the answered class is exactly it. The flood layer inherits the same rule: one
authority, one product, one zone vocabulary per artifact, read from the manifest, and a reader that
refuses anything else.

**Cells outside England get no row.** Not completeness zero — the EA's statement says nothing about
Wales, Scotland or Northern Ireland, and each has a different authority with a different scheme.

**Two limits, both from the EA's own text, that the coverage row cannot express:**

1. **Non-uniform vintage inside one layer.** "For particular areas, sections of the previous Flood
   Zone dataset (November 2023) have been retained whilst we make improvements to the data." This is a
   currency limit, not a coverage gap — those areas are mapped, to an older model. The attribute set
   (`Origin`, `Flood_zone`, `Flood_source`) carries no per-feature date, so **the layer cannot state a
   per-feature vintage**, and the manifest's single `source_vintage` is the only honest granularity
   available. Recording that limit is the requirement; inferring a per-feature date is not available.
2. **What the product excludes by construction.** "They do not take account of the presence and effect
   of flood defences, unless they increase the area potentially at risk of flooding", and "Locations
   may also be at risk from other sources of flooding, such as high groundwater levels, or failure of
   infrastructure such as sewers and storm drains. These sources are not represented in these
   datasets." A Zone 1 reading is silent about surface water, groundwater and defended-area residual
   risk. The observation must name the product it read, so a consumer can see what the answer covers.

### 3.3 United States — three distinct absences, and only one of them is coverage

FEMA is the more instructive source here, because it models absence with polygons and a dedicated
availability layer rather than with holes. Three cases, and conflating any two of them is the defect:

1. **Outside the NFHL footprint — no data.** Layer 0 of the REST service is "NFHL Availability", a
   polygon layer whose only job is to say where NFHL data exists. FEMA's own map legend carries three
   categories: **"Digital Data Available"**, **"No Digital Data Available"**, **"Unmapped"**. The
   metadata adds "Currently, not all areas of a State or Territory have effective FIRM Database data.
   As a result, users may need to refer to the effective FIRM for effective flood hazard information."
   Printed exports covering these areas "cannot be used for regulatory purposes".
2. **Inside a FIRM's extent, but excluded — an `ANI` polygon.** From the FIRM Database Technical
   Reference (November 2024), the `ANI_TF` field: "Areas Not Included fall within the extent of the
   FIRM but no flood risk information is shown. This is either because the area is mapped on another
   FEMA map or because the area is not mapped at all by FEMA."
3. **Mapped, but no analysis was run — Zone D.** From the
   [FEMA glossary](https://www.fema.gov/about/glossary/zone-d) (updated June 22, 2022), complete:
   "Areas with possible but undetermined flood hazards. No flood hazard analysis has been conducted.
   Flood insurance rates are commensurate with the uncertainty of the flood risk."

What makes case 1 separable from cases 2 and 3 is FEMA's wall-to-wall rule. Guidance Document No. 36
(November 2022) §12.7:

> "The S_Fld_Haz_Ar layer stores information about the FEMA designated flood zone for all mapped areas
> of the jurisdiction. All areas within the jurisdiction should be covered by one and only one
> non-overlapping S_Fld_Haz_Ar polygon."

Inside a mapped jurisdiction there are no holes: where a zone cannot be assigned FEMA fills with a
coded polygon (`ANI` for area not included, `OW` for open water, `NP` for area not mapped under levee
seclusion). So:

**The basis this supports:** `designated`, `completeness = 1.0`, for cells the availability layer
reports as "Digital Data Available"; **no row at all** for "No Digital Data Available" and for
"Unmapped". The availability layer is the source's own coverage statement, which is the cleanest input
to `layer_coverage` of any source in this survey.

**The trap that follows, and it is the reason §3.1 is worded as it is.** A cell can be `designated`
complete and still hold a Zone D or `ANI` polygon — a determination that no determination was made.
If a reader took `supportsExclusion(cell) === true` as licence to answer "no flood hazard here", it
would fire identically on a Zone X location (determined to be outside the SFHA) and on a Zone D
location (nobody looked). **The coverage row licenses only that the authority made a determination;
the hazard reading is the zone value, and Zone D's value is "undetermined".** A builder that folds
`ANI`, `NP`, `OW` and `D` into "no hazard" produces a well-formed wrong answer of exactly the class
this repository keeps writing down.

## 4. The layer schema sketch

### 4.1 The zone vocabulary is the authority's, verbatim

The layer stores the code the authority published, in the authority's own spelling, with the
authority's date. No score, no severity ordering, no cross-country scale. Two authorities that both
publish "flood zones" are not publishing the same thing — England's Zone 3 is a 1% annual probability
from rivers ignoring defences, FEMA's Zone AE is a 1% annual chance with base flood elevations, and a
column that made them comparable would be this record's invention rather than either authority's
statement.

**England**, from PPG Table 1 (the zones are defined by the planning guidance, and the EA says so; the
EA's own restatement differs slightly and is recorded here as such):

| zone                              | PPG definition, verbatim                                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zone 1 Low Probability            | "Land having a less than 0.1% annual probability of river or sea flooding. (Shown as 'clear' on the Flood Map for Planning – all land outside Zones 2, 3a and 3b)"     |
| Zone 2 Medium Probability         | "Land having between a 1% and 0.1% annual probability of river flooding; or land having between a 0.5% and 0.1% annual probability of sea flooding."                   |
| Zone 3a High Probability          | "Land having a 1% or greater annual probability of river flooding; or Land having a 0.5% or greater annual probability of sea."                                        |
| Zone 3b The Functional Floodplain | "This zone comprises land where water from rivers or the sea has to flow or be stored in times of flood… (Not separately distinguished from Zone 3a on the Flood Map)" |

Three consequences a builder must carry rather than smooth over. **3a and 3b are not in the data** —
the published layer's `Flood_zone` holds "Flood Zone 2" or "Flood Zone 3", and the EA states "The
Environment Agency are not required to map the outer boundary of the extent of Flood Zone 3b, and it
is usually included within our mapped extent of Flood Zone 3". **The EA's own Zone 2 restatement adds
a clause the PPG probability definition does not carry** — "or accepted recorded flood outlines" — so
the two definitions are not interchangeable and the layer should record which one it is repeating.
And PPG Table 1 carries its own note: "The Flood Zones shown on the Environment Agency's Flood Map for
Planning (Rivers and Sea) do not take account of the possible impacts of climate change."

**United States**, the complete `D_Zone` domain from the Domain Tables Technical Reference (November
2024), 13 coded values: `A`, `A99`, `AE`, `AH`, `AO`, `AR`, `ANI` (AREA NOT INCLUDED), `D`, `NP` (NOT
POPULATED), `OW` (OPEN WATER), `V`, `VE`, `X`. Two structural points: the dual forms `AR/AE`, `AR/AO`,
`AR/A` are **not** `FLD_ZONE` values — dual zones are carried by `AR_REVERT` / `AR_SUBTRV` /
`DUAL_ZONE`; and the domain's second column mostly echoes the code, so it is not a definition column.
`ZONE_SUBTY` carries 35 coded values (`0.2-PCT-ANNUAL-CHANCE FLOOD HAZARD`, `FLOODWAY`, `AREA OF
MINIMAL FLOOD HAZARD`, `AREA WITH REDUCED FLOOD HAZARD DUE TO ACCREDITED LEVEE SYSTEM`, and so on).

A string-form warning that will bite a naive parser, and FEMA states the reconciliation rule itself:
the Domain Tables spell the subtype with hyphens (`0.2-PCT-ANNUAL-CHANCE FLOOD HAZARD`) while the
shipped FIRM database does not, because "the dashes will stay in the Domain Tables Technical
Reference, however the FIRM DB template will not have dashes". The December 2020 edition spelled it
`PERCENT` rather than `PCT`. Parse tolerantly across the hyphen and across `PCT`/`PERCENT`.

**The schema consequence.** `zone_code` holds the source's value as published. The builder carries the
authority's declared domain as a closed set and **throws** on a value outside it. An unknown code is a
source-schema change, which is the event a reader most needs to hear about; coercing it to a nearest
neighbour or to null converts "the source changed" into "there is nothing here".

### 4.2 Tables

Four domain tables plus the two contract tables. Written as Kysely schema modules with the typed
interface co-located with its `createXTable`, per the house database discipline.

```
flood_zone_area          -- one row per authority polygon, plain rowid table (it holds a blob)
  area_id        TEXT     -- the authority's own feature id (EA OBJECTID; FEMA FLD_AR_ID)
  zone_code      TEXT     -- the authority's value, verbatim
  zone_subtype   TEXT?    -- FEMA ZONE_SUBTY; NULL where the source has no such field
  zone_source    TEXT?    -- EA Flood_source; FEMA SFHA_TF
  origin         TEXT?    -- EA Origin (modelled / recorded / …)
  panel_id       TEXT?    -- FEMA DFIRM_ID; NULL for EA
  effective_date TEXT?    -- the authority's own date, ISO-8601, where it publishes one
  min_lat, min_lon, max_lat, max_lon  REAL   -- precomputed bbox, the ray-cast prefilter
  rings          BLOB     -- the authority's ring coordinates, unsimplified

flood_zone_cell          -- the build-time containment structure, WITHOUT ROWID
  h3_cell        INTEGER  -- 48-bit short cell at the declared resolution
  area_id        TEXT
  containment    TEXT     -- 'whole' | 'partial'
  PRIMARY KEY (h3_cell, area_id)

flood_map_extent         -- the authority's mapped footprint, which is NOT the union of hazard polygons
  extent_id      TEXT
  status         TEXT     -- FEMA: 'digital' | 'no_digital' | 'unmapped'; EA: one row for England
  effective_date TEXT?

flood_zone_vocabulary    -- the authority's declared domain, as shipped, so the reader can refuse an unknown code
  zone_code      TEXT
  definition     TEXT     -- the authority's own words
  definition_url TEXT

layer_manifest / layer_coverage   -- the contract tables, from @mailwoman/core/layers
```

`WITHOUT ROWID` on `flood_zone_cell` and not on `flood_zone_area` follows the contract's own guidance
— small fixed-width rows probed by their exact primary key belong in the B-tree; a row carrying a
geometry blob does not.

`flood_map_extent` exists as a table of its own because on the FEMA side it is a distinct published
layer (availability, layer 0) and on the EA side it is a one-row statement of the coverage sentence in
§3.2. Deriving it from the hazard polygons would be exactly the error §3.3 describes: the union of
hazard polygons is not the mapped area, because Zone 1 and Zone X are the mapped area minus the
polygons.

### 4.3 Manifest fields

| field                       | EA pilot value                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `name`                      | `flood-zones-ea-england`                                                                         |
| `version`                   | the EA revision date of the file ingested                                                        |
| `tier`                      | `shipped` — OGL v3.0 permits redistribution with acknowledgement                                 |
| `license`                   | the OGL v3.0 identifier                                                                          |
| `attribution`               | "© Environment Agency copyright and/or database right 2025. All rights reserved."                |
| `source` / `source_vintage` | the dataset id and its published revision date                                                   |
| `build_cmd` / `build_sha`   | the invocation and the commit that produced it                                                   |
| `freshness_policy`          | `versioned-refresh` — the EA states an intent to republish, and re-issues under the same product |
| `spine_keys`                | `{ h3: { column: …, resolution: … } }` — see §4.5                                                |
| `created_at`                | caller-supplied, per the contract                                                                |

A FEMA-sourced artifact could not take `tier: shipped` on the evidence in §2.2, because "access
constraints: None" plus an acknowledgement request is not a redistribution license, and choosing to
publish on that basis is a decision, not a reading. `build-local` is the posture that needs no such
decision.

### 4.4 The resolution is a measurement the pilot takes

SCOPE invariant 6 asks of anything that looks like it needs a spatial query: is it really a
containment question build time can precompute? A flood-zone determination is exactly a containment
question, so the build converts the authority's polygons into an H3 containment index and the runtime
probes that index by key.

The conversion cannot be total, and saying where it stops is the design. A cell lying **wholly** inside
one zone polygon is answered by the index alone, with no geometry at runtime. A cell the boundary
**crosses** carries every zone reaching into it, and a point in such a cell has no answer from the
index by itself. Two readings are then available and both are honest: report the mixture ("the
authority's map assigns more than one zone within this cell"), or ray-cast the point against the rings
of the few candidate polygons the index already named. The second is the spatial math invariant 6
permits at an irreducibly geometric runtime edge, in the same class as reverse geocoding, and it is
bounded because the index has reduced the candidate set to what one cell touches.
`pointInPolygonRings` and `bboxAround` in `@mailwoman/spatial` are the primitives; nothing new is
needed.

The interior/boundary distinction is not new machinery either — `coverage-region.ts` already separates
a polyfilled cell set from the cells lying wholly inside an outline, and measured 371 polyfilled
against 290 interior on Île-de-France.

**What must be measured, not argued:** the share of cells that come out `partial` at each candidate
resolution, on the pilot region, over the real 813,627 polygons. That share decides whether the index
answers most queries on its own or whether the ray-cast is the common path, and it is a property of
England's floodplain geometry that no amount of reasoning about cell areas will produce. The pilot
reports the number at each resolution it tries and picks from the measurement.

### 4.5 A polygon row is not addressable by one spine key

The contract requires every domain row to be addressable by at least one spine key, and a polygon is
not: it spans many cells. `SpineKeys` has already grown once for precisely this reason — the situs
shards carry no cell, no WOF id and no address-id, so `street` was added rather than naming a column
that does not exist. A cell-indexed geometry layer is the same kind of event, and this record does not
settle it.

The two candidate answers for the builder: declare `h3` naming `flood_zone_cell.h3_cell`, which is
true (the layer _is_ addressable by cell) but points a consumer at the index rather than at the domain
table; or grow a fourth spine-key kind that says what this shape is. Either way the decision is
written down, because a manifest naming a column that does not exist is worse than either.

## 5. The pilot

### 5.1 The source: England, Environment Agency Flood Map for Planning — Flood Zones

Four reasons, in the order they bind.

1. **The acquisition path is reachable and was exercised.** The three file sizes in §2.1 are measured
   by GET from this network. FEMA's three distribution hosts reset the TLS handshake here, reproduced
   with two clients against both resolved addresses. A pilot whose first step cannot run is not a
   pilot.
2. **The license is verified and permits what a `shipped` layer needs.** OGL v3.0 with a published
   attribution string. FEMA publishes no license grant at all; §2.2 shows the nearest artifacts are a
   data.gov field pointing at a page that declines a blanket grant, and a site-wide statement about
   website content. Building the first flood layer on a source whose distribution posture is a judgment
   call would put that judgment inside a pilot that exists to test something else.
3. **One product, one file, one layer, two zone values.** 813,627 polygons, a 367 MB geodatabase, a
   five-column schema. The FEMA equivalent is 2,670 per-jurisdiction artifacts with 13 zone codes and
   35 subtypes across two container formats.
4. **It puts the meaning-of-zero rule under maximum pressure, which is the point.** Zone 1 is
   represented by _absence_ in the data, and the authority defines it that way. Inside England an empty
   answer is a designation; outside England the same empty answer is unknown. A layer that cannot tell
   those apart is the exact failure this program exists to prevent, and the EA data cannot be built
   correctly without solving it.

FEMA stays in the inventory as the source with the strongest coverage semantics anywhere in this
survey — an availability layer, a wall-to-wall polygon rule, and an explicit undetermined-hazard code.
It is the natural second layer, once the acquisition path and the distribution question are settled.

### 5.2 The region

**England, whole.** The bounded region is the product's own extent rather than a sub-region, because
the EA publishes England as one file and the coverage claim in §3.2 is stated at England scale. A
county-scale slice would be a smaller build of the same thing, not a different claim.

The verification ladder still runs on a smaller area first — see below — but the artifact the pilot
produces covers what the authority's statement covers, which keeps the manifest's declared extent and
the coverage rows describing the same set.

### 5.3 The verification ladder

**Fixtures.** Hand-built geometry, no network. A square zone polygon, an adjacent one, one with a
hole, and a mapped-extent rectangle smaller than the cells the polygons reach. It asserts: a
wholly-interior cell resolves without geometry; a boundary cell reports its mixture; a point inside
the extent and outside every polygon reads as the authority's Zone 1 designation and **not** as "no
row"; a point outside the extent produces no coverage row at all; and an undeclared zone code throws
rather than being coerced.

**Smoke.** One administrative area of the real file. This verifies what fixtures structurally cannot:
the actual field names and value domain (`Flood_zone` really holding "Flood Zone 2"/"Flood Zone 3"),
the coordinate reference system, the relationship between the extent and the polygons, and the seal.
The first live poi.db builds caught three bugs that 800+ green tests missed, all of them source-schema
or scale behavior.

**Full.** All of England, end to end, plus two checks that only exist at full scale. Memory must stay
flat in row count — the poi build ran out of heap at 13.68M rows because a reader materialized
instead of streaming, and geometry blobs are heavier per row than POI points. And the coverage insert
must be chunked: `writeLayerCoverage` already batches at `COVERAGE_INSERT_BATCH`, and a builder that
hand-rolls its own insert re-earns SQLite's 32,766 bound-variable ceiling.

**And an agreement check against a second path.** A sample of points from the built artifact,
re-asked of the EA's own WFS or OGC API Features endpoint, with the agreement rate reported. Same
authority, different distribution channel — which is what makes it a check on our conversion rather
than on the authority. Its negative half matters as much: a sample of points in Wales and Scotland,
confirming the artifact returns **no coverage row** rather than a Zone 1 reading.

That last check is the one that would have caught the class of defect §3 is about, and it is cheap.

### 5.4 The consumer shape

**Which paths may attach it.** The geocode path only, after the resolver has produced a coordinate for
the node the caller asked about. The parse path has no coordinate to ask about. The POI branch is
answering a different question.

**Default off, and the switch is the presence of the layer path** rather than a boolean — the shape
`poiSemanticLookup` settled, because a boolean makes the factory construct the reader itself and puts
a layer open on the default construction path. The flag lands with its row in the
[runtime-flag register](../../engineering/reference/runtime-flags.mdx) in the same change; SCOPE
invariant 5 makes a flag with no register row a smell.

**Ranking untouched, and the receipt is byte-stability.** The same query, with and without the layer
attached, returns an identical result plus one advisory. That is a statement about construction — the
carrier reads no candidate, no coordinate and no ordering — and a test pins it.

**What the observation says.** The zone code as published, the product and authority that published
it, the version of the file it came from, the coverage cell with its basis, and the containment
reading (`whole` cell, or a ray-cast against a named polygon). Enough for a reader to re-derive the
claim rather than take it. And the wording carries §3.1's constraint: it reports what the authority's
map assigns at the location, never whether the property is at risk.

### 5.5 The carrier, and the one place it does not fit

`QueryIntentMarker` is the carrier. Its contract is already the requirement: a marker is additive,
attributed, always accompanied by the ordinary answer, and never changes which answer wins. It carries
`mechanism` in the `family:rule` form and an `evidence` record, which is where everything in the
paragraph above goes. `coverage_qualified_absence` is the same architecture, already shipped.

**The place it does not fit, stated rather than papered over.** `QueryIntentMarker.kind` names a query
kind the verdict carries, and a flood observation is not raised by intent at all. `declared_ambiguity`
is the precedent for a marker raised at resolve time rather than by the classifier, so that half is
established — but that marker names `bare_toponym`, a kind of its own, and this one has no kind of its
own. It would name the verdict's own top kind. The builder issue either accepts that in writing or
widens the carrier; picking one is outside a survey.

Two alternatives, rejected with reasons. **`AnnotationSet`** is the existing home for
coordinate-derived facts (timezone, NUTS, FIPS) and would look like the natural fit, but it has no
field for provenance or for a coverage basis, and every member of it maps into an OpenCage-compatible
block where a flood designation has no counterpart — so it would carry the zone and drop the
epistemics, which are the whole content. **A private field on the geocode result** is the second path
the shared carrier exists to prevent; `absence-route.ts` says so in place.

## 6. The product requirement

A caller who geocodes an address in a region where an authority publishes a flood-hazard map receives,
alongside the ordinary result and without changing it, that authority's own flood-zone designation for
the resolved coordinate: the zone code in the authority's vocabulary, the product and version it was
read from, the authority's own effective date where one is published, and the coverage record stating
that the authority made a determination there. Where the authority publishes no determination — a
location outside its jurisdiction, an area it has not mapped, or a designation that says the hazard is
undetermined — the caller receives that fact rather than a reassuring one, and an unmapped area is
never reported as a low-hazard area. The observation states what the map assigns at a location and
never whether a property will flood, because the authorities themselves decline that second statement.
Ranking, abstention and every existing result field are unchanged; the observation is additive,
attributed, and default off.

## 7. The builder-issue outline

Not filed here. The outline, for the issue that lands against this survey:

**Shape.** Following `bdc`: a workspace holds acquisition, parsing and the layer reader; the CLI is
thin wiring. `gazetteer build bdc` takes `--state` as a FIPS code, which is the precedent for a
region-scoped build; the EA equivalent takes the product version and an optional administrative area
for the smoke rung.

**Registration.** A new workspace joins six registers and only the first fails loudly — the root
`workspaces` array, the `.release-it.json` publish list (or a `SANCTIONED_RELEASE_ABSENCES` entry with
the reason as data), **both** root `tsconfig.json` reference entries, and the
`smoke-clean-install.ts` pack set; the full paragraph with the bless-package obligation for a
brand-new npm name is in the root `AGENTS.md`. Re-run the release-list arithmetic afterwards — it
currently reads 59 workspaces, 53 in the list, six absent with a stated reason each.

**Acquisition.** The rule binds where the rule actually draws its line: metadata reads and per-feature
WFS queries are API requests and go through `APIClient`; a 367 MB archive streamed to disk is a file
transfer and keeps raw `fetch`, saying so in place, as `osm/sdk/fetch.ts` and `tiger/sdk/download.ts`
do. Note in the client that `HEAD` returns 405 and `Range` is ignored, so freshness cannot be probed
by content length.

**Build.** Ingest the geodatabase; build `flood_zone_area` with precomputed bboxes and unsimplified
rings; polyfill each polygon to the candidate resolutions and record `whole`/`partial` per cell;
derive `flood_map_extent` from the authority's coverage statement rather than from the polygon union;
write `layer_coverage` at `basis = designated`, `completeness = 1.0` for cells inside England and no
row outside; write the manifest; seal 0444; build-then-swap.

Two known traps to write into the builder: `polygonToCells` from h3-js takes `[lat, lng]` per vertex
in its default (non-GeoJSON) mode, which `coverage-region.ts` and `build-poi.ts` both comment in place;
and the coverage cell for a row must be `cellToParent` of its finer cell, matching every existing
reader, rather than a direct `latLngToCell` at the coarse resolution.

**Measure and report** the `partial` cell share at each candidate resolution (§4.4), and pick from the
measurement.

**Verify** on the fixtures → smoke → full ladder in §5.3, ending with the two-path agreement check and
its negative half.

**Wire** the observation per §5.4/§5.5, default off, with its runtime-flag register row, and a
byte-stability test with the layer absent.

**Settle in writing** the two questions §1 leaves open: the spine-key declaration for a polygon layer,
and whether the advisory code extends the query-intent vocabulary or widens the carrier.

## 8. What could not be verified

Recorded as gaps rather than filled in.

**EU level.**

- **The JRC dataset catalogue URLs, file sizes, return-period lists and download mechanisms were not
  re-emitted to this record.** The DOIs, resolutions, return-period count and license above are
  carried from the delegated verification; the per-dataset catalogue pages and sizes are not, so a
  builder must re-read them before acquiring either JRC product. Nothing turns on this, because §2.3
  excludes both from the layer on grounds that do not depend on those fields.
- **An explicit property-level-use caveat from any EU primary source** — searched exhaustively and
  none found. Recorded as a verified absence rather than an unchecked item, which matters: the
  absence of a caveat is not permission, and the scale recommendation is what constrains use.
- **Whether Reportnet 3 offers any public export retaining geometry** — public endpoints serve zip
  only; authenticated endpoints return 401.
- **A single aggregated download of the flood-map link register** — only per-country XML deliveries
  and the viewer's embedded popup HTML were found.
- **Four endpoints listed on the current EEA SDI record do not work** — two answer "Service not
  started" and two return 404. A builder reading that record would find half its links dead.

**FEMA.**

- **The distribution hosts are unreachable from this network.** `hazards.fema.gov`, `msc.fema.gov`
  and `floodmaps.fema.gov` reset the TLS handshake; `www.fema.gov` returns 403 to non-browser clients.
  Every FEMA fact above came through a browser, an Internet Archive capture of FEMA's own URL, a
  US-egress reader proxy, or a named mirror. The live NFHL ArcGIS REST metadata was also attempted
  directly from this session twice and returned `ECONNRESET` both times.
- **No FEMA public-domain or 17 U.S.C. §105 statement for NFHL geospatial data** — a checked absence
  across five sources (the NFHL page, the FGDC metadata, the MSC products page, the MSC FAQ, and the
  FEMA_MAC ArcGIS item, whose `accessInformation` is null), not an unchecked gap.
- **A count of communities on paper-only or unmodernized maps** — no primary figure was reached. This
  is the digital/paper split the issue asked for, and it is the one part of it that remains a hole:
  the digital side is measurable (2,670 databases, ">90% of population"), the paper-only side is not.
- **NFIP participating-community counts disagree across three FEMA systems** — 22,772 (Community
  Status Book PDF), 22,782 (OpenFEMA API), 23,452 (`nation.csv` rows marked YES), all read the same
  day. Unreconciled; presented as three figures rather than averaged.
- **A single national "NFHL_National" artifact** appears only in a search-engine summary, is absent
  from FEMA's own inventory, and no FEMA page stating it was found. Do not build against it.
- **The statewide `productID` download pattern** — FEMA's factsheet documents county and community
  patterns only.
- **Per-code FEMA prose definitions for Zone A, AH, A99 and VE** — the `zone-a` glossary slug returns
  an empty filter result and no slugs were found for the other three. The Flood Zones overview covers
  them collectively; per-code wording was not reconstructed from memory.
- **Layer-id to table-name confirmation** — that service layer 28 is literally `S_Fld_Haz_Ar` and
  layer 3 literally `S_FIRM_Pan` is strongly indicated by the layer names and attributes but was not
  byte-confirmed by fetching each layer's field list.
- **A numeric LOMR-into-NFHL turnaround target** — searched across the LOMR incorporation guidance,
  a second LOMR guidance document, the 2016 Standards and the metadata; only a one-business-day
  _bundling_ rule exists, which is not a turnaround.
- **MSC and hazards terms-of-use pages** — the hazards footer link is a session-encoded URL on the
  blocked host and is not archived under a stable address.

**Environment Agency.**

- **The area-of-interest download flow's mechanics** for RoFRS, RoFSW and the Surface Water Spatial
  Planning products — whether it is a bounding box, a tile grid or an administrative picker, what
  formats it offers, and what the files weigh. The `/explore/{id}?download=true` page is a client-side
  application that returns only its shell; three candidate JSON endpoints returned the same shell.
  Consequently **no file sizes exist for those six datasets** either.
- **Whether an account is required** for that download flow. The platform header offers "Create an
  account" and "Login"; whether either is required was not determined. This does not affect the pilot, whose product
  has direct file URLs.
- **Ordnance Survey terms on the RoFRS "Properties in Areas at Risk" product**, which carries `UPRN`
  derived from OS AddressBase and `TOPO_TOID` from OS MasterMap while its licensing section names OGL
  with no OS carve-out. Open question before redistributing that specific product; it is not part of
  the pilot.
- **Licence and zone definitions for Wales (NRW), Scotland (SEPA) and Northern Ireland (DfI)** — each
  was located and none was verified. Wales in particular uses a four-zone TAN15 scheme that is not
  interchangeable with England's, so a "UK flood zone" layer built by pooling them would pool
  incompatible vocabularies.
- **Whether the retired Flood Zone 2 / Flood Zone 3 spatial data is archived anywhere** — the CKAN
  records confirm the resources are gone; no archive copy was located.
