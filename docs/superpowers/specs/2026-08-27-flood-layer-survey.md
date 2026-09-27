# Flood-zone risk as a spatial layer — source survey and pilot design

This is the design record for #1983. It is a survey, and it performs no build. It records which
authorities publish flood-hazard data we could carry, what each one's own terms permit and forbid, what
a layer built from one would be allowed to claim, and which single source and region the first build
should use. The builder is a follow-up issue, outlined in §7 and not filed here.

The consuming implementation already exists, so no section below proposes new architecture. The layer
interface (`layer_manifest` / `layer_coverage` on the H3 spine) is specified in
[`../../engineering/reference/layer-interface.mdx`](../../engineering/reference/layer-interface.mdx).
`packages/bdc` is the worked example of a federal-provider layer. The exclusion-grade coverage pilot
([`2026-08-27-exclusion-grade-coverage-pilot.md`](./2026-08-27-exclusion-grade-coverage-pilot.md), PR
#1973) defines the coverage-basis rules. The observation carrier that shipped with PR #1979 delivers an
additive advisory with provenance and leaves ranking unchanged. The missing piece was knowledge of the
sources, and this record supplies it.

**Every external claim below carries its URL and the date it was read.** Where a fact could not be
established from a primary source, §8 lists it as unverified, with what was tried. No entry in §8 was
filled in with a plausible reading.

## 1. What this record settles, and what it deliberately does not

Settled here: the verified inventory (§2), what each source's own coverage statement licenses a
`layer_coverage` row to say (§3), the schema shape a flood layer takes under the existing interface
(§4), the pilot's source, region, verification ladder and consumer shape (§5), and the product
requirement (§6).

This record leaves four questions open, listed here so nobody reads silence as a decision:

- the H3 resolution the containment index is built at (§4.4). The pilot measures it, and this record
  does not choose it.
- the spine-key declaration for a polygon layer (§4.5). The interface has handled this shape before,
  and the builder decides.
- whether the observation's advisory code extends the existing query-intent vocabulary or widens the
  carrier (§5.5).
- any distribution decision for a FEMA-derived artifact. §2.2 shows that such a decision would rest on
  a license statement FEMA does not publish.

The issue puts two things out of scope, and this record keeps them out: any ranking or abstention
change, and any non-authoritative risk modeling. The layer records what an authority states, in the authority's vocabulary, with the
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
both carry a retirement notice pointing at the replacement, and the data has been removed. A
`package_show` query against the data.gov.uk CKAN API returns three resources for each: a
`Data Version.txt`, a `.lyr` layer file, and a guidance PDF. **No spatial data remains on either
record.** A builder written against the old dataset ids would download files that contain no data.

The current product holds both zones in one layer. The EA's FAQ
([environment.data.gov.uk/support/faqs/778338325](https://environment.data.gov.uk/support/faqs/778338325))
states its lineage and one behavioral change that matters to a consumer:

> "From 25 March 2025, the Flood Zones are produced as part of the new National Flood Risk Assessment
> (NaFRA2)."

> "Flood Zones 2 and 3 will no longer overlap, with clear attribution between the Flood Zones."

A reader that previously treated Zone 2 as containing Zone 3 is wrong against the current data.

**Schema.** Layer `Flood_Zones_2_3_Rivers_and_Sea`, polygon geometry, five columns: `OBJECTID`,
`Shape`, `Origin` ("Source of data (modelled, recorded, direct rainfall model, local evidence)"),
`Flood_zone` ("Assigned Flood Zone (Flood Zone 2 or 3)"), `Flood_source` ("river and/or sea and/or
undefined"). A WFS `resultType=hits` request returns `numberMatched="813627"`.

<!-- vale off -->

**License — OGL v3.0, verified.** The ISO metadata's `gmd:useLimitation` is "Open Government
Licence" and its `gmd:otherConstraints` is "There are no public access constraints to this data. Use
of this data is subject to the licence identified." The data.gov.uk record links to
[the OGL v3.0 text](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). The
required attribution string is given in the metadata:

<!-- vale on -->

> "© Environment Agency copyright and/or database right 2025. All rights reserved."

OGL v3.0 requires that a re-user

<!-- vale off -->

> "acknowledge the source of the Information in your product or application by including or linking
> to any attribution statement specified by the Information Provider(s) and, where possible, provide
> a link to this licence"

<!-- vale on -->

The WFS `GetCapabilities` reports `<ows:Fees>NONE`. The license permits redistribution with a named
acknowledgement, which is what a `shipped` layer requires.

**Acquisition — direct whole-England file URLs, sizes measured by GET.** The download base is
`https://environment.data.gov.uk/api/file/download?fileDataSetId=455d2eb3-3065-4d20-871b-c4d5dee23f67&fileName=…`:

| format               | file name                                        |         bytes |
| -------------------- | ------------------------------------------------ | ------------: |
| File geodatabase zip | `Flood_Map_for_Planning_Flood_Zones.gdb.zip`     |   366,897,893 |
| GeoPackage zip       | `Flood_Map_for_Planning_Flood_Zones.gpkg.zip`    |   969,511,188 |
| GeoJSON zip          | `Flood_Map_for_Planning_Flood_Zones.geojson.zip` | 4,490,553,481 |

One acquisition detail has a cost. The server answers `HEAD` with HTTP 405 and ignores `Range` (it
returns 200 with the full length), so a size probe starts a real download. A builder therefore cannot
cheaply check freshness by content length.

Services: WFS 2.0.0 at
`https://environment.data.gov.uk/spatialdata/flood-map-for-planning-flood-zones/wfs` (layer
`dataset-04532375-a198-476e-985e-0579a0a11b47:Flood_Zones_2_3_Rivers_and_Sea`), WMS at `…/wms`, OGC
API Features at `…/ogc/features/v1`. Advertised WFS output formats include `GEOJSON`, `Geopackage`,
`csv`, `KML`, `gml3`, `gml32`.

**Cadence.** ISO `MD_MaintenanceFrequencyCode` is `asNeeded` on every current EA flood dataset
checked, so the metadata gives no fixed schedule. The product description (published 30/06/2026)
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
interest and format" pointing at `https://environment.data.gov.uk/explore/{id}?download=true`. **Neither
product offers WFS, OGC API Features, or a direct file URL.** An unattended bulk download is possible
for the Flood Zones and not for these. On 2026-05-28 the EA published four Surface Water Spatial Planning datasets
that superseded RoFSW _for planning use_; the older product stays available but "should no longer be
used for planning decisions" (same FAQ).

**The other UK nations have different authorities with different schemes**, and none of their terms
were verified here:

- Wales: [Natural Resources Wales](https://naturalresources.wales/flooding/flood-map-for-planning/),
  with a four-zone scheme under TAN15 that is not interchangeable with England's.
- Scotland: [SEPA](https://map.sepa.org.uk/floodmaps), with downloads at
  [www2.sepa.org.uk/flooddata](https://www2.sepa.org.uk/flooddata/).
- Northern Ireland:
  [DfI Rivers](https://www.infrastructure-ni.gov.uk/articles/how-flood-maps-ni-was-produced), whose
  page states the same 3 km² catchment floor England uses.

### 2.2 United States — FEMA National Flood Hazard Layer

All facts in this section read **2026-08-27**.

**Retrieval obstacle, stated first because it changes the pilot decision.** `hazards.fema.gov`,
`msc.fema.gov` and `floodmaps.fema.gov` accept a TCP connection on 443 from this network and then
reset the TLS handshake. Both curl and a real Chromium reproduce this against both DNSSEC-validated
addresses (18.253.155.176 and 182.30.81.39, where Cloudflare and Google DoH agree with `AD=true`), so
DNS resolution is working. The behavior is consistent with a geographic block. Separately,
`www.fema.gov` answers non-browser clients with HTTP 403. **Every FEMA fact below was therefore
obtained through a real browser, an Internet Archive capture of FEMA's own URL, a US-egress reader
proxy, or a named non-FEMA mirror**, and the source notes label each one. The distribution endpoints
an ingest would call are unreachable from here today.

**License — FEMA publishes no public-domain statement, and that absence was checked.** The issue
expected public domain, and FEMA does not state it. The canonical FGDC metadata
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

That text is an acknowledgement _request_ plus a restriction on who may change NFIP flood-risk
information. It neither grants a license nor restricts redistribution. The same record addresses
distribution liability: "No warranty expressed or implied is made by FEMA regarding the utility of
the data on any other system nor shall the act of distribution constitute any such warranty."

The nearest artifacts to a license are (a) the FEMA-published data.gov entry
[catalog.data.gov/dataset/national-flood-hazard-layer](https://catalog.data.gov/dataset/national-flood-hazard-layer)
(identifier `FEMA-0145`, modified 2025-04-01), whose JSON-LD sets
`"license": "https://www.usa.gov/government-works"` with `rights: null`. That URL redirects to
[usa.gov/government-copyright](https://www.usa.gov/government-copyright), which declines a blanket
grant ("Not everything that appears on a federal government website is a government work… Check with
the federal agency"). (b) FEMA's site-wide
[website-information](https://www.fema.gov/about/website-information) page (updated May 1, 2023) says
"Most material on FEMA.gov is free of copyright and may be copied and distributed without
permission". That statement covers website content and does not mention NFHL data. A **second**
data.gov entry carrying the same license field is published by HIFLD rather than FEMA, and must not be
cited as FEMA's.

**FEMA's own policy contradicts the premise that the NFHL is an unofficial copy.** No FEMA statement
calls the NFHL unofficial or informational-only. FEMA Policy #204-078-1 Rev 13, _Standards for Flood Risk Analysis and Mapping_,
SID 605 (effective 2014-11-30; read from the
[Idaho State University mirror](https://giscenter.isu.edu/pdf/PDF_FEMA_DOS/fema_policy-standards-flood-risk-analysis-mapping-rev-13.pdf)
because fema.gov's copy refuses non-browser clients) says the opposite:

> "Flood Insurance Rate Maps, FIRMettes, and NFHL Databases are the official FEMA digital products.
> The official FEMA digital products and printed versions produced from the official digital products
> are all equivalent to each other and represent official FEMA designations of the areas of special
> flood hazard, base flood elevations, insurance risk zones and other regulatory information,
> provided that all other geospatial data shown on the printed product meets or exceeds any accuracy
> standard promulgated by FEMA."

The condition applies to the base map a product is combined with rather than to the NFHL itself. The only
use restrictions apply to **preliminary and pending** data, which "cannot be used to rate flood
insurance policies or enforce the Federal mandatory purchase requirement" (NFHL GIS Services guide),
and to printed exports covering unmapped areas.

**Extent and the digital/paper split.** FEMA states digital coverage of "over 90 percent of the U.S.
population" on the [NFHL page](https://www.fema.gov/flood-maps/national-flood-hazard-layer) (updated
2025-04-03), and its EMI course IS-0273 states the limit more directly:

> "NFHL digital data coverage is not nationwide but it covers over 90 percent of the U.S.
> population."

A separate and larger figure covers the _whole_ mapping inventory including paper: the April 2026
[Notice to Congress](https://www.fema.gov/sites/default/files/documents/fema_rsl_notice-congress_042026.pdf)
reports "approximately 1.3 million miles of flooding sources (riverine and coastal) which covers
communities that make up 98% of the U.S. population", against "1.2 million unmapped miles" and "1.1
million miles on Federal Lands and do not need to be mapped". The two population figures measure
different objects and come from documents without a shared stated denominator, so neither may be
subtracted from the other.

A parse of FEMA's live download inventory (`https://hazards.fema.gov/femaportal/NFHL/searchResult`,
read through the proxy) counted **2,670 NFHL database entries**: 2,504 countywide plus 166
single-jurisdiction, across 56 states and territories. Per-entry update dates range from 2000-01-19 to
2026-08-10, and the total is ~88.9 GB, with a median of 18 MB and a maximum of 776 MB. Four independent
token counts over the same page agree at 2,670. That count measures the digital side. It is not a
FEMA-published coverage statistic, and it has no stated denominator.

**A count of communities on paper-only or unmodernized maps was not found** (§8).

**Formats and acquisition.** County and community extracts are shapefiles in a zip, and state extracts
are a file geodatabase in a zip (per the University of New Hampshire GRANIT clearinghouse's
[instructions](https://granitweb.sr.unh.edu/MetadataForViewers/CommonViewers/RelatedDocuments/floodDownloadInstructions.pdf),
corroborated by FEMA's own MSC naming). The direct-download pattern, from FEMA's own
[factsheet](https://msc.fema.gov/msccontent/FEMA_Hazard_Products_Direct_Download.pdf):

> "The standard direct download format contains two parts: the static prefix and the Product ID… An
> example full URL is: https://msc.fema.gov/portal/downloadProduct?productID=NFHL_51013C"

The product id is therefore `NFHL_<5-digit-FIPS>C` for a county and `NFHL_<6-digit-CID>` for a
community. The factsheet does not document the statewide productID pattern (§8).

Services: ArcGIS REST at `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer`, WMS
at `…/public/NFHLWMS/MapServer/WMSServer`, WFS at
`https://hazards.fema.gov/arcgis/services/public/NFHL/MapServer/WFSServer`. The live service
definition reports `maxRecordCount` 2000, `supportedQueryFormats` `JSON, geoJSON, PBF`,
`spatialReference` wkid 4269 (NAD83), and **empty strings for `serviceDescription`, `description` and
`copyrightText`**. The service carries no attribution or license text at all. The WFS caps a request
at 1,000 features. In FEMA's own wording: "Requests are currently limits to 1000 features, so it is
recommended that users focus on a very limited area of interest when requesting data through WFS." No
rate limit, quota, or API key is published for the NFHL services or MSC downloads.

FEMA's published GIS Services guide numbers layers differently from the live service, read the same
day. The guide lists LOMAs at 2 and a layer 21 that the live service lacks, while the live service
serves LOMAs at 34. **Bind to layer names rather than to the guide's ids.**
`S_Fld_Haz_Ar` is layer 28 ("Flood Hazard Zones"); `S_FIRM_Pan` is layer 3 ("FIRM Panels"); the
NFHL availability polygons are layer 0.

**Cadence.** The metadata's maintenance frequency is "Monthly", describing the per-state distribution
sets ("It is updated on a monthly basis"), while the underlying layer is "Continuously updated". The
two statements describe two different objects and do not contradict each other. Currency is per
distribution set: "Each State or Territory data set consists of all FIRM Databases and corresponding
LOMRs available on the publication date of the data set." A county update is a **wholesale
replacement keyed on `DFIRM_ID`** rather than a patch. Guidance Document 12 (February 2019) §7.0
describes removing all layers for a `DFIRM_ID` and replicating the new ones, and _Standards for Flood
Risk Projects_ (Nov 2016) SID
610 requires that "the NFHL must replace all data for a submitted dataset (i.e. DFIRM_ID) in its
entirety". A diff between two NFHL vintages therefore compares whole jurisdictions.

### 2.3 EU level — the central repository of member-state flood maps does not exist

All facts in this section read **2026-08-27**. A plausible guess would have been wrong here. An EU row
in this inventory would naturally be a merged, downloadable set of the member states' own flood hazard
maps, and **that set does not exist, because the reporting rule forbids it.** The _Floods Directive GIS
Guidance_ v1.4
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
[EU Flood Risk Areas Viewer](https://discomap.eea.europa.eu/floodsviewer/) serves four layers (units
of management, plus areas of potential measured flood risk as point, line and polygon) and no hazard
extents. The Commission describes it as "a single gateway to all Member States' preliminary flood risk
assessments, flood hazard and risk maps, and flood risk management plans in the national language/s",
which in practice means a set of links. The **INSPIRE Geoportal, which the guidance points to, is
retired**. data.europa.eu states "the INSPIRE Geoportal will be retired on 1 July 2026", and its
successor is a metadata catalogue of national service endpoints in several schemas, projections,
languages and licenses rather than a merged layer.

**What is centrally downloadable is one dataset, and it is not hazard extents.** "Floods Reference
Spatial Datasets reported under Floods Directive — version 3.0, Mar. 2025"
([EEA SDI record `f0606e9f-0ce2-4c1b-93b0-0af0ce0725e4`](https://sdi.eea.europa.eu/catalogue/srv/api/records/f0606e9f-0ce2-4c1b-93b0-0af0ce0725e4);
the v2.0 record is superseded) is a 1,455,656,960-byte GeoPackage in EPSG:4326 holding 330,523 APSFR
polygons, 1,209 points and 3,330 lines. Its attribute schema has **neither depth, return period, nor
scenario**. Measurement of the file itself found two further traps. Despite the "Mar. 2025" title, its
contents are 2nd-cycle data (`cYear` 2018 for 330,462 rows), and the file lacks the
units-of-management layer its own abstract promises. License: "License CC-BY 4.0… Copyright holder:
European Environment Agency (EEA)" with "no limitations to public access". The dataset has no DOI.

**The EU-level products that do carry flood hazard are modeled rather than designated.** The JRC river flood
hazard maps for Europe are published at 3 arc-seconds (≈ 90 m) over nine return periods under CC BY
4.0, DOI `10.2905/1D128B6C-A4EE-4858-9E34-6210707F3C81`. The global equivalent is 3 arc-seconds
current with a 30 arc-second legacy edition, DOI `10.2905/JRC.VD32YWG`. Copernicus Land Monitoring
carries no standing pan-European flood hazard product. Copernicus Emergency Management's on-demand
mapping responds to an actual event and is not a standing hazard layer.

**Why none of this becomes the pilot, and it is not the resolution.** These are pan-European
_models_ rather than any authority's designation of a location. They fall outside what §3.1 allows this
layer to report, and inside what the issue puts out of scope. Two published statements make the point
without the resolution argument. The viewer's own about-panel says: "Member States define
what constitutes a potentially measured flood risk depending on their particular circumstances and
flood risk management approaches… **Direct comparisons between Member States are therefore not
advisable.**" And the reference dataset's declared equivalent scale is 1:100,000, with the GIS
guidance recommending "positional accuracy acceptable for cartographic representation at the
1:100.000 scale or larger". A search across the WISE page, the viewer configuration, all four EEA SDI
Floods records, the EEA data policy, both guidance documents and the Commission pages found **no**
literal caveat against property-level use. That absence was checked rather than assumed. The scale
recommendation, the comparability warning, and the EEA's "as is" clause are the closest primary
statements.

For this program, **a European flood layer has to be built country by country from each member
state's own maps**, reached through the link register, and England is the first. No central shortcut
exists.

### 2.4 Deliberately not surveyed

- **Member-state flood maps outside England** (France, Germany, and the rest). Each state publishes
  its own maps under its own terms. None were verified here, and this record makes no claim about them.
- **Modeled risk products that are not an authority's designation.** The issue puts non-authoritative
  risk modeling out of scope, and this record keeps it out. The layer's value comes from repeating an
  authority, and a modeled score would be a different product with different obligations.

### 2.5 The inventory, side by side

|                         | **EA — Flood Map for Planning: Flood Zones**                         | **FEMA — National Flood Hazard Layer**                                                                                                                             | **EU level**                                                                          |
| ----------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| authority               | Environment Agency (England)                                         | FEMA (US)                                                                                                                                                          | none — member states are the authorities                                              |
| what it is              | an authority's designation                                           | an authority's designation                                                                                                                                         | a link register, plus JRC models                                                      |
| license                 | **OGL v3.0**, verified in ISO metadata; attribution string published | **No license grant published.** Access constraints "None"; acknowledgement "would be appreciated"; data.gov carries `usa.gov/government-works` with `rights: null` | reference dataset CC BY 4.0 without a DOI; JRC maps CC BY 4.0 with DOIs               |
| extent                  | England only; ISO bbox 49.943–55.816 N, −6.236–2.072 E               | Not nationwide. ">90% of U.S. population" digital; 2,670 county/community databases measured                                                                       | EU-wide for the models; **no central hazard extents at all**                          |
| vocabulary              | Flood Zone 2, Flood Zone 3 (Zone 1 = absence)                        | 13 `FLD_ZONE` codes + 35 `ZONE_SUBTY` codes                                                                                                                        | none — the reference dataset has no depth, return period or scenario                  |
| vintage                 | pub 2025-03-25, rev 2026-05-20                                       | per-jurisdiction; measured update dates 2000-01-19 → 2026-08-10                                                                                                    | "Mar. 2025" title over 2018-cycle contents                                            |
| cadence                 | ISO `asNeeded`; three-month publication stated as intent             | monthly state sets; continuous underlying layer; wholesale `DFIRM_ID` replacement                                                                                  | six-year reporting cycles; 3rd cycle due 2026-03-22, 12 of 27 states public           |
| format                  | GDB 367 MB · GPKG 970 MB · GeoJSON 4.49 GB (measured)                | county/community shapefile zip; state file-geodatabase zip; ~88.9 GB total, median 18 MB                                                                           | GeoPackage 1.36 GiB (measured); JRC rasters at 3 arc-seconds                          |
| acquisition             | direct file URL + WFS + OGC API Features                             | `downloadProduct?productID=NFHL_…`; ArcGIS REST / WMS / WFS                                                                                                        | anonymous HTTP for the reference dataset; per-country national endpoints otherwise    |
| reachable from this lab | **yes** — sizes measured by GET                                      | **no** — TLS reset on all three distribution hosts                                                                                                                 | yes                                                                                   |
| usable for this layer   | **yes — the pilot**                                                  | yes, once acquisition and distribution are settled                                                                                                                 | **no** — models rather than designations, and explicitly not comparable across states |

## 3. Coverage honesty per source

This section prevents the failure #1964 fixed for POIs: an unmapped area read as a safe one. For
flood data that failure is worse than for pharmacies. Readers most want to interpret the absence of a
hazard polygon, and both authorities publish an explicit warning against interpreting it loosely.

### 3.1 The claim a coverage row is allowed to make

`CoverageBasis.Designated` means "An authority declares the set complete for this cell". The set both
authorities declare complete is **their own designation** rather than the world's flood risk. The
strongest negative claim a flood layer can support is therefore:

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

That second quotation is the strongest constraint in this record. The pilot resolves addresses, and
the authority says its map is not suitable for a property-level determination. The layer therefore
reports **which zone the authority's map assigns to the location**, which is a fact about the map. It
never reports **whether the property is at risk**, which the authority declines to state. The
observation's wording must keep this distinction, as well as this document.

### 3.2 England — what is mapped, what is not, and the basis it supports

The EA publishes a coverage statement, which is what makes `designated` reachable at all:

> "The mapping of Flood Zone datasets covers all of England, down to catchments with an area of 3km2.
> Where we have suitable data for smaller catchments, we will also show this."

And the Planning Practice Guidance defines Zone 1 as the absence itself
([gov.uk/guidance/flood-risk-and-coastal-change](https://www.gov.uk/guidance/flood-risk-and-coastal-change),
Table 1, Paragraph 078, Reference ID 7-078-20220825):

> **Zone 1 Low Probability** — "Land having a less than 0.1% annual probability of river or sea
> flooding. (Shown as 'clear' on the Flood Map for Planning – all land outside Zones 2, 3a and 3b)"

Inside England, a location without a polygon is therefore surveyed, and it is Zone 1 by the
authority's own definition. That is the storable form of a designated absence, and the coverage row
exists to store it.

**The basis this supports:** `designated`, `completeness = 1.0`, for every cell inside England. The
layer's identity carries the class boundary, and the completeness number does not. The set declared
complete is _Flood Zone 2 and 3 from rivers and the sea, for catchments of 3 km² and above_. A
catchment below that floor is outside the class, in the same way a parapharmacie was outside the
pharmacy class in the #1964 pilot. A class boundary is not incompleteness, and encoding it as a
fractional completeness would invent a measurement nobody took.

That reasoning only holds if the layer cannot be read as covering a class it does not hold, and the
interface has already solved this problem. `absence-route.ts` records it: a coverage table carries a
completeness per cell and no class, so a completeness measured over pharmacies could license a claim
about cafés if no check stopped it. The route reads the held class from the artifact and refuses unless
the requested class matches it exactly. The flood layer inherits the same rule: one authority, one
product, and one zone vocabulary per artifact, read from the manifest, with a reader that refuses
anything else.

**Cells outside England get no row**, rather than a row with completeness zero. The EA's statement makes no
claim about Wales, Scotland or Northern Ireland, and each has a different authority with a different
scheme.

**The EA's own text sets two limits that the coverage row cannot express:**

1. **Non-uniform vintage inside one layer.** "For particular areas, sections of the previous Flood
   Zone dataset (November 2023) have been retained whilst we make improvements to the data." This is a
   currency limit rather than a coverage gap, because those areas are mapped with an older model. The
   attribute set (`Origin`, `Flood_zone`, `Flood_source`) carries no per-feature date, so **the layer
   cannot state a per-feature vintage**. The manifest's single `source_vintage` is the finest
   granularity available. The layer must record that limit, and it cannot infer a per-feature date.
2. **What the product excludes by construction.** "They do not take account of the presence and effect
   of flood defences, unless they increase the area potentially at risk of flooding", and "Locations
   may also be at risk from other sources of flooding, such as high groundwater levels, or failure of
   infrastructure such as sewers and storm drains. These sources are not represented in these
   datasets." A Zone 1 reading makes no claim about surface water, groundwater or residual risk in
   defended areas. The observation must identify the product it read, so a consumer can see what the
   answer covers.

### 3.3 United States — three distinct absences, and only one of them is coverage

FEMA is the more instructive source here, because it represents absence with polygons and a dedicated
availability layer rather than with holes. There are three cases, and conflating any two of them is a
defect:

<!-- vale off -->

1. **Outside the NFHL footprint — no data.** Layer 0 of the REST service is "NFHL Availability", a
   polygon layer whose only job is to say where NFHL data exists. FEMA's own map legend carries three
   categories: **"Digital Data Available"**, **"No Digital Data Available"**, **"Unmapped"**. The
   metadata adds "Currently, not all areas of a State or Territory have effective FIRM Database data.
   As a result, users may need to refer to the effective FIRM for effective flood hazard information."
   Printed exports covering these areas "cannot be used for regulatory purposes".

<!-- vale on -->

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

A mapped jurisdiction therefore has no holes. Where a zone cannot be assigned, FEMA fills the area
with a coded polygon (`ANI` for area not included, `OW` for open water, `NP` for area not mapped under
levee seclusion).

**The basis this supports:** `designated`, `completeness = 1.0`, for cells the availability layer
reports as "Digital Data Available", and **no row at all** for "No Digital Data Available" and for
"Unmapped". The availability layer is the source's own coverage statement, which makes it the cleanest
input to `layer_coverage` of any source in this survey.

**This creates a trap, and the trap is why §3.1 is worded as it is.** A cell can be `designated`
complete and still hold a Zone D or `ANI` polygon, which records a determination that no
determination was made. If a reader took `supportsExclusion(cell) === true` as license to answer "no
flood hazard here", it
would fire identically on a Zone X location (determined to be outside the SFHA) and on a Zone D
location (nobody looked). **The coverage row licenses only that the authority made a determination;
the hazard reading is the zone value, and Zone D's value is "undetermined".** A builder that folds
`ANI`, `NP`, `OW` and `D` into "no hazard" produces a well-formed wrong answer, the same class of
defect this repository has recorded repeatedly.

## 4. The layer schema sketch

### 4.1 The zone vocabulary is the authority's, verbatim

The layer stores the code the authority published, in the authority's own spelling, with the
authority's date. It adds no score, severity ordering, or cross-country scale. Two authorities that
both publish "flood zones" are publishing different things. England's Zone 3 is a 1% annual
probability from rivers, ignoring defences. FEMA's Zone AE is a 1% annual chance with base flood
elevations. A column that made them comparable would be this record's invention rather than either
authority's statement.

**England**, from PPG Table 1. The planning guidance defines the zones, and the EA says so. The EA's
own restatement differs slightly, and this record notes where:

| zone                              | PPG definition, verbatim                                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zone 1 Low Probability            | "Land having a less than 0.1% annual probability of river or sea flooding. (Shown as 'clear' on the Flood Map for Planning – all land outside Zones 2, 3a and 3b)"     |
| Zone 2 Medium Probability         | "Land having between a 1% and 0.1% annual probability of river flooding; or land having between a 0.5% and 0.1% annual probability of sea flooding."                   |
| Zone 3a High Probability          | "Land having a 1% or greater annual probability of river flooding; or Land having a 0.5% or greater annual probability of sea."                                        |
| Zone 3b The Functional Floodplain | "This zone comprises land where water from rivers or the sea has to flow or be stored in times of flood… (Not separately distinguished from Zone 3a on the Flood Map)" |

<!-- vale off -->

A builder must preserve three consequences rather than smooth them over. First, **3a and 3b are not in
the data**. The published layer's `Flood_zone` holds "Flood Zone 2" or "Flood Zone 3", and the EA
states "The Environment Agency are not required to map the outer boundary of the extent of Flood Zone
3b, and it is usually included within our mapped extent of Flood Zone 3". Second, **the EA's own Zone
2 restatement adds a clause that the PPG probability definition lacks**: "or accepted recorded flood
outlines". The two definitions are not interchangeable, and the layer should record which one it
repeats. Third, PPG Table 1 carries its own note: "The Flood Zones shown on the Environment Agency's Flood Map for
Planning (Rivers and Sea) do not take account of the possible impacts of climate change."

<!-- vale on -->

**United States**, the complete `D_Zone` domain from the Domain Tables Technical Reference (November
2024), 13 coded values: `A`, `A99`, `AE`, `AH`, `AO`, `AR`, `ANI` (AREA NOT INCLUDED), `D`, `NP` (NOT
POPULATED), `OW` (OPEN WATER), `V`, `VE`, `X`. Two structural points: the dual forms `AR/AE`, `AR/AO`,
`AR/A` are **not** `FLD_ZONE` values, because `AR_REVERT` / `AR_SUBTRV` / `DUAL_ZONE` carry dual
zones. The domain's second column mostly repeats the code, so it is not a definition column.
`ZONE_SUBTY` carries 35 coded values (`0.2-PCT-ANNUAL-CHANCE FLOOD HAZARD`, `FLOODWAY`, `AREA OF
MINIMAL FLOOD HAZARD`, `AREA WITH REDUCED FLOOD HAZARD DUE TO ACCREDITED LEVEE SYSTEM`, and so on).

The string forms differ in a way that will break a naive parser, and FEMA states the reconciliation
rule itself. The Domain Tables spell the subtype with hyphens (`0.2-PCT-ANNUAL-CHANCE FLOOD HAZARD`) while the
shipped FIRM database does not, because "the dashes will stay in the Domain Tables Technical
Reference, however the FIRM DB template will not have dashes". The December 2020 edition spelled it
`PERCENT` rather than `PCT`. Parse tolerantly across the hyphen and across `PCT`/`PERCENT`.

**The schema consequence.** `zone_code` holds the source's value as published. The builder carries the
authority's declared domain as a closed set and **throws** on a value outside it. An unknown code
means the source schema changed, which a reader most needs to know. Coercing it to a nearest neighbour
or to null would turn "the source changed" into "there is no data here".

### 4.2 Tables

The layer has four domain tables plus the two interface tables. They are written as Kysely schema
modules, with each typed interface co-located with its `createXTable`, per the repository's database
conventions.

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

layer_manifest / layer_coverage   -- the interface tables, from @mailwoman/core/layers
```

`flood_zone_cell` uses `WITHOUT ROWID` and `flood_zone_area` does not, following the interface's own
guidance. Small fixed-width rows probed by their exact primary key belong in the B-tree, and a row
carrying a geometry blob does not.

`flood_map_extent` is a separate table because on the FEMA side it is a distinct published layer
(availability, layer 0), and on the EA side it is a one-row statement of the coverage sentence in
§3.2. Deriving it from the hazard polygons would repeat the error §3.3 describes. The union of hazard
polygons is not the mapped area, because Zone 1 and Zone X are the mapped area minus the polygons.

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
| `created_at`                | caller-supplied, per the interface                                                               |

A FEMA-sourced artifact could not take `tier: shipped` on the evidence in §2.2. "Access constraints:
None" plus an acknowledgement request is not a redistribution license, and publishing on that basis
would be a decision rather than a reading of FEMA's terms. `build-local` needs no such decision.

### 4.4 The resolution is a measurement the pilot takes

SCOPE invariant 6 asks of anything that looks like it needs a spatial query: is it really a
containment question build time can precompute? A flood-zone determination is exactly a containment
question, so the build converts the authority's polygons into an H3 containment index and the runtime
probes that index by key.

The conversion cannot cover every case, and the design is defined by where it stops. The index alone
answers a cell lying **wholly** inside one zone polygon, with no geometry at runtime. A cell that the
boundary **crosses** carries every zone reaching into it, and the index alone cannot answer a point in
such a cell. Two answers are then possible, and both are accurate. The layer can report the mixture
("the authority's map assigns more than one zone within this cell"), or it can ray-cast the point
against the rings of the few candidate polygons the index already returned. Invariant 6 permits that
spatial math at an irreducibly geometric runtime edge, in the same class as reverse geocoding. The
cost is bounded because the index has reduced the candidate set to the polygons one cell touches.
`pointInPolygonRings` and `bboxAround` in `@mailwoman/spatial` are the primitives, so no new primitive is
needed.

The interior/boundary distinction also exists already. `coverage-region.ts` separates a polyfilled
cell set from the cells lying wholly inside an outline, and it measured 371 polyfilled against 290
interior on Île-de-France.

**What must be measured rather than argued:** the share of cells that come out `partial` at each candidate
resolution, on the pilot region, over the real 813,627 polygons. That share decides whether the index
answers most queries on its own or whether the ray-cast is the common path. It is a property of
England's floodplain geometry, and reasoning about cell areas cannot predict it. The pilot reports the
number at each resolution it tries and chooses based on the measurement.

### 4.5 A polygon row is not addressable by one spine key

The interface requires every domain row to be addressable by at least one spine key, and a polygon is
not, because it spans several cells. `SpineKeys` has already been extended once for this reason. The
situs extracts carry neither a cell, a WOF id, nor an address-id, so `street` was added rather than
declaring a column that does not exist. A cell-indexed geometry layer raises the same question, and
this record does not decide it.

The builder has two candidate answers. It can declare `h3` pointing at `flood_zone_cell.h3_cell`,
which is accurate (the layer _is_ addressable by cell) but points a consumer at the index rather than
at the domain table. Or it can add a fourth spine-key kind that describes this shape. Either way the
decision must be written down, because a manifest that declares a nonexistent column is worse than
either option.

## 5. The pilot

### 5.1 The source: England, Environment Agency Flood Map for Planning — Flood Zones

Four reasons support this choice, in order of weight.

1. **The acquisition path is reachable and was exercised.** The three file sizes in §2.1 were measured
   by GET from this network. FEMA's three distribution hosts reset the TLS handshake here, reproduced
   with two clients against both resolved addresses. A pilot cannot start with a step that cannot run.
2. **The license is verified and permits what a `shipped` layer needs.** It is OGL v3.0 with a
   published attribution string. FEMA publishes no license grant at all. §2.2 shows that the nearest
   artifacts are a data.gov field pointing at a page that declines a blanket grant, and a site-wide
   statement about website content. If the first flood layer used a source whose distribution posture
   requires a judgment call, that judgment would sit inside a pilot built to test something else.
3. **One product, one file, one layer, two zone values.** The EA product has 813,627 polygons, a
   367 MB geodatabase, and a five-column schema. The FEMA equivalent is 2,670 per-jurisdiction
   artifacts with 13 zone codes and 35 subtypes across two container formats.
4. **It tests the meaning-of-zero rule as hard as possible, which is intended.** The data represents
   Zone 1 by _absence_, and the authority defines it that way. Inside England an empty answer is a
   designation, and outside England the same empty answer means unknown. A layer that cannot tell those
   apart is the failure this program exists to prevent, and the EA data cannot be built correctly
   without handling it.

FEMA stays in the inventory as the source with the strongest coverage semantics in this survey: an
availability layer, a wall-to-wall polygon rule, and an explicit undetermined-hazard code. It is the
natural second layer once the acquisition path and the distribution question are settled.

### 5.2 The region

**England, whole.** The region is the product's own extent rather than a sub-region, because the EA
publishes England as one file and states the coverage claim in §3.2 at England scale. A county-scale
build would be a smaller build of the same product and would support no different claim.

The verification ladder still runs on a smaller area first (see below). The artifact the pilot
produces covers what the authority's statement covers, so the manifest's declared extent and the
coverage rows describe the same set.

### 5.3 The verification ladder

**Fixtures.** Hand-built geometry without network access: a square zone polygon, an adjacent one, one
with a hole, and a mapped-extent rectangle smaller than the cells the polygons reach. The fixtures
assert that:

- a wholly-interior cell resolves without geometry;
- a boundary cell reports its mixture;
- a point inside the extent and outside every polygon reads as the authority's Zone 1 designation and
  **not** as "no row";
- a point outside the extent produces no coverage row at all;
- an undeclared zone code throws rather than being coerced.

**Smoke.** One administrative area of the real file. This verifies what fixtures structurally cannot:
the actual field names and value domain (`Flood_zone` really holding "Flood Zone 2"/"Flood Zone 3"),
the coordinate reference system, the relationship between the extent and the polygons, and the seal.
The first live poi.db builds caught three bugs that 800+ passing tests missed, all involving
source-schema or scale behavior.

**Full.** All of England, end to end, plus two checks that only apply at full scale. Memory must stay
flat as row count grows. The poi build ran out of heap at 13.68M rows because a reader materialized
rows instead of streaming them, and geometry blobs are heavier per row than POI points. The coverage
insert must also be chunked. `writeLayerCoverage` already batches at `COVERAGE_INSERT_BATCH`, and a
builder with its own hand-written insert would hit SQLite's 32,766 bound-variable ceiling again.

**Agreement check against a second path.** Take a sample of points from the built artifact, query the
EA's own WFS or OGC API Features endpoint for the same points, and report the agreement rate. The
authority is the same and the distribution channel differs, so the check tests our conversion rather
than the authority. Its negative half matters as much: a sample of points in Wales and Scotland must
return **no coverage row** from the artifact rather than a Zone 1 reading.

That last check is cheap, and it would have caught the class of defect §3 describes.

### 5.4 The consumer shape

**Which paths may attach it.** Only the geocode path may attach it, after the resolver has produced a
coordinate for the node the caller asked about. The parse path has no coordinate to look up, and the
POI branch answers a different question.

**The observation is off by default, and supplying the layer path turns it on**, rather than a
boolean. `poiSemanticLookup` established this pattern, because a boolean makes the factory construct
the reader itself and opens a layer on the default construction path. The flag lands in the same
change as its row in the [runtime-flag register](../../engineering/reference/runtime-flags.mdx),
because SCOPE invariant 5 treats a flag without a register row as a defect.

**Ranking is unchanged, and byte-stability is the evidence.** The same query, with and without the
layer attached, returns an identical result plus one advisory. That follows from how the carrier is
constructed: it reads no candidate, coordinate or ordering, and a test pins that.

**What the observation says.** It reports the zone code as published, the product and authority that
published it, the version of the file it came from, the coverage cell with its basis, and the
containment reading (`whole` cell, or a ray-cast against a named polygon). That is enough for a reader
to re-derive the claim rather than accept it. The wording also follows §3.1's constraint: it reports
what the authority's map assigns at the location, never whether the property is at risk.

### 5.5 The carrier, and the one place it does not fit

`QueryIntentMarker` is the carrier, and its interface already meets the requirement. A marker is
additive and attributed, it always accompanies the ordinary answer, and it never changes which answer
wins. It carries `mechanism` in the `family:rule` form and an `evidence` record, which holds everything
listed in the paragraph above. `coverage_qualified_absence` already ships with the same architecture.

**The carrier does not fit in one place.** `QueryIntentMarker.kind` holds a query kind the verdict
carries, and intent does not raise a flood observation at all. `declared_ambiguity` is the precedent
for a marker raised at resolve time rather than by the classifier, so that part is established. That
marker, however, uses `bare_toponym`, a kind of its own, and a flood observation has no kind of its
own. It would have to use the verdict's own top kind. The builder issue must either accept that in
writing or widen the carrier. A survey does not make that choice.

Two alternatives were rejected. **`AnnotationSet`** is the existing home for coordinate-derived facts
(timezone, NUTS, FIPS) and looks like the natural fit. It has no field for provenance or for a
coverage basis, however, and every member of it maps into an OpenCage-compatible block where a flood
designation has no counterpart. It would carry the zone and drop the provenance and coverage basis,
which are the whole content. **A private field on the geocode result** is the separate path that the
shared carrier exists to prevent, as `absence-route.ts` states in its comments.

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

The builder issue is not filed here. This outline is for the issue that lands against this survey.

**Shape.** Following `bdc`, a workspace holds acquisition, parsing and the layer reader, and the CLI is
thin wiring. `gazetteer build bdc` takes `--state` as a FIPS code, which is the precedent for a
region-scoped build; the EA equivalent takes the product version and an optional administrative area
for the smoke rung.

**Registration.** A new workspace joins six registers, and only the first produces an error when it
is missing. The registers are the root `workspaces` array, the `.release-it.json` publish list (or a
`SANCTIONED_RELEASE_ABSENCES` entry with the reason as data), **both** root `tsconfig.json` reference
entries, and the `smoke-clean-install.ts` pack set. The root `AGENTS.md` has the full paragraph,
including the bless-package obligation for a brand-new npm name. Re-run the release-list arithmetic
afterwards. It currently reads 59 workspaces, 53 in the list, and six absent with a stated reason each.

**Acquisition.** The API-client rule applies up to its stated boundary. Metadata reads and per-feature
WFS queries are API requests and go through `APIClient`. A 367 MB archive streamed to disk is a file
transfer and keeps raw `fetch`, with a comment saying so, as `osm/sdk/fetch.ts` and
`tiger/sdk/download.ts` do. Note in the client that `HEAD` returns 405 and `Range` is ignored, so
freshness cannot be probed by content length.

**Build.**

1. Ingest the geodatabase.
2. Build `flood_zone_area` with precomputed bboxes and unsimplified rings.
3. Polyfill each polygon to the candidate resolutions and record `whole`/`partial` per cell.
4. Derive `flood_map_extent` from the authority's coverage statement rather than from the polygon
   union.
5. Write `layer_coverage` at `basis = designated`, `completeness = 1.0` for cells inside England, and
   write no row outside.
6. Write the manifest, seal 0444, and build-then-swap.

The builder must handle two known traps. `polygonToCells` from h3-js takes `[lat, lng]` per vertex in
its default (non-GeoJSON) mode, as comments in `coverage-region.ts` and `build-poi.ts` both note. The
coverage cell for a row must also be `cellToParent` of its finer cell, matching every existing reader,
rather than a direct `latLngToCell` at the coarse resolution.

**Measure and report** the `partial` cell share at each candidate resolution (§4.4), and choose based
on the measurement.

**Verify** on the fixtures → smoke → full ladder in §5.3, ending with the two-path agreement check and
its negative half.

**Wire** the observation per §5.4/§5.5, default off, with its runtime-flag register row, and a
byte-stability test with the layer absent.

**Settle in writing** the two questions §1 leaves open: the spine-key declaration for a polygon layer,
and whether the advisory code extends the query-intent vocabulary or widens the carrier.

## 8. What could not be verified

These items are recorded as gaps rather than filled in.

**EU level.**

- **The JRC dataset catalogue URLs, file sizes, return-period lists and download mechanisms were not
  re-emitted to this record.** The DOIs, resolutions, return-period count and license above come from
  the delegated verification. The per-dataset catalogue pages and sizes do not, so a builder must
  re-read them before acquiring either JRC product. No decision depends on this, because §2.3 excludes
  both from the layer on grounds that do not depend on those fields.
- **An explicit property-level-use caveat from any EU primary source.** An exhaustive search found
  none. This is recorded as a verified absence rather than an unchecked item. The absence of a caveat
  is not permission, and the scale recommendation is what constrains use.
- **Whether Reportnet 3 offers any public export retaining geometry.** Public endpoints serve zip
  only, and authenticated endpoints return 401.
- **A single aggregated download of the flood-map link register.** Only per-country XML deliveries
  and the viewer's embedded popup HTML were found.
- **Four endpoints listed on the current EEA SDI record do not work.** Two answer "Service not
  started" and two return 404. A builder reading that record would find half its links dead.

**FEMA.**

- **The distribution hosts are unreachable from this network.** `hazards.fema.gov`, `msc.fema.gov`
  and `floodmaps.fema.gov` reset the TLS handshake, and `www.fema.gov` returns 403 to non-browser
  clients. Every FEMA fact above came through a browser, an Internet Archive capture of FEMA's own URL,
  a US-egress reader proxy, or a named mirror. Two direct requests for the live NFHL ArcGIS REST
  metadata from this session both returned `ECONNRESET`.
- **No FEMA public-domain or 17 U.S.C. §105 statement for NFHL geospatial data.** This absence was
  checked across five sources (the NFHL page, the FGDC metadata, the MSC products page, the MSC FAQ,
  and the FEMA_MAC ArcGIS item, whose `accessInformation` is null), so it is not an unchecked gap.
- **A count of communities on paper-only or unmodernized maps.** No primary figure was found. This is
  the digital/paper split the issue asked for, and it is the one part that remains unanswered. The
  digital side is measurable (2,670 databases, ">90% of population"), and the paper-only side is not.
- **NFIP participating-community counts disagree across three FEMA systems:** 22,772 (Community
  Status Book PDF), 22,782 (OpenFEMA API), and 23,452 (`nation.csv` rows marked yes), all read the
  same day. They are unreconciled and presented as three figures rather than averaged.
- **A single national "NFHL_National" artifact** appears only in a search-engine summary and is absent
  from FEMA's own inventory. No FEMA page describing it was found. Do not build against it.
- **The statewide `productID` download pattern.** FEMA's factsheet documents only the county and
  community patterns.
- **Per-code FEMA prose definitions for Zone A, AH, A99 and VE.** The `zone-a` glossary slug returns
  an empty filter result, and no slugs were found for the other three. The Flood Zones overview covers
  them collectively. Per-code wording was not reconstructed from memory.
- **Layer-id to table-name confirmation.** The layer names and attributes strongly indicate that
  service layer 28 is literally `S_Fld_Haz_Ar` and layer 3 is literally `S_FIRM_Pan`, but fetching
  each layer's field list to confirm it byte-for-byte was not done.
- **A numeric LOMR-into-NFHL turnaround target.** A search across the LOMR incorporation guidance, a
  second LOMR guidance document, the 2016 Standards and the metadata found only a one-business-day
  _bundling_ rule, which is not a turnaround.
- **MSC and hazards terms-of-use pages.** The hazards footer link is a session-encoded URL on the
  blocked host and is not archived under a stable address.

**Environment Agency.**

- **The area-of-interest download flow's mechanics** for RoFRS, RoFSW and the Surface Water Spatial
  Planning products: whether it uses a bounding box, a tile grid or an administrative picker, which
  formats it offers, and how large the files are. The `/explore/{id}?download=true` page is a
  client-side application that returns only its shell, and three candidate JSON endpoints returned the
  same shell. Consequently **no file sizes exist for those six datasets** either.
- **Whether an account is required** for that download flow. The platform header offers "Create an
  account" and "Login", and this survey did not determine whether either is required. This does not
  affect the pilot, whose product has direct file URLs.
- **Ordnance Survey terms on the RoFRS "Properties in Areas at Risk" product.** The product carries
  `UPRN` derived from OS AddressBase and `TOPO_TOID` from OS MasterMap, while its licensing section
  cites OGL without an OS carve-out. This question must be answered before redistributing that
  specific product, which is not part of the pilot.
- **License and zone definitions for Wales (NRW), Scotland (SEPA) and Northern Ireland (DfI).** Each
  was located, and none was verified. Wales in particular uses a four-zone TAN15 scheme that is not
  interchangeable with England's, so a "UK flood zone" layer built by pooling them would pool
  incompatible vocabularies.
- **Whether the retired Flood Zone 2 / Flood Zone 3 spatial data is archived anywhere.** The CKAN
  records confirm the resources are gone, and no archive copy was located.
