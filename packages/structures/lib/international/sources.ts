/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Structure sources that span countries.
 *   These are the inputs of the basemaps the map draws, plus the catalog that individual landmark models come from.
 */

import { LicenseReviewState, type LicenseDecision } from "@mailwoman/core/license/decision"

import { permittedByGrant } from "#grants"
import { RESEARCH_HANDOFF_NOTE } from "#research"
import { INTERNATIONAL, StructureDetail, type StructureOperation, type StructureSource } from "#types"

/**
 * The retrieval date of every terms copy this module cites.
 */
const RETRIEVED_AT = "2026-10-22"

/**
 * The directory, relative to the repository root, that holds the retrieved terms copies.
 */
const TERMS = "packages/structures/data/licenses"

/**
 * Structure sources that span countries: the basemap inputs, the elevation tiles
 * behind the hillshade, and the Commons model catalog.
 */
export const INTERNATIONAL_SOURCES: readonly StructureSource[] = [
	{
		sourceID: "international-osm",
		jurisdiction: INTERNATIONAL,
		name: "OpenStreetMap",
		publisher: "OpenStreetMap contributors",
		datasetURL: "https://www.openstreetmap.org/copyright",
		detail: [StructureDetail.Footprint, StructureDetail.RoofAttributes],
		formats: ["OSM PBF (Geofabrik extract)"],
		license: "international-osm",
		attribution: "© OpenStreetMap contributors, available under the Open Database License",
		attributionURL: "https://www.openstreetmap.org/copyright",
	},
	{
		sourceID: "international-overture-buildings",
		jurisdiction: INTERNATIONAL,
		name: "Overture Maps buildings theme",
		publisher: "Overture Maps Foundation",
		datasetURL: "https://docs.overturemaps.org/guides/buildings/",
		detail: [StructureDetail.Footprint, StructureDetail.RoofAttributes],
		formats: ["GeoParquet"],
		license: "international-overture",
		attribution:
			"Overture Maps buildings: OpenStreetMap contributors (ODbL), Esri Community Maps contributors (CC BY 4.0), " +
			"Microsoft Global ML Building Footprints (ODbL), Google Open Buildings (CC BY 4.0), USGS 3DEP, " +
			"Shi et al. East Asian buildings, doi:10.5281/zenodo.8174931 (CC BY 4.0), work derived from BTN 2024 ign.es " +
			"(CC BY 4.0)",
		attributionURL: "https://docs.overturemaps.org/attribution/",
		note: "Overture states that building parts currently derive from OpenStreetMap.",
	},
	{
		sourceID: "international-overture-base",
		jurisdiction: INTERNATIONAL,
		name: "Overture Maps base theme (land and ocean)",
		publisher: "Overture Maps Foundation",
		datasetURL: "https://docs.overturemaps.org/guides/base/",
		detail: [StructureDetail.LandCover],
		formats: ["GeoParquet"],
		license: "international-overture",
		attribution:
			"Overture Maps base: OpenStreetMap contributors (ODbL), Daylight Map Distribution, © ESA WorldCover project " +
			"2020 / contains modified Copernicus Sentinel data (2020) processed by ESA WorldCover consortium, ETOPO1, " +
			"GLOBathy",
		attributionURL: "https://docs.overturemaps.org/attribution/",
	},
	{
		sourceID: "international-meta-wri-chm",
		jurisdiction: INTERNATIONAL,
		name: "High Resolution Canopy Height Maps",
		publisher: "Meta and World Resources Institute",
		datasetURL: "https://registry.opendata.aws/dataforgood-fb-forests/",
		detail: [StructureDetail.HeightRaster],
		formats: ["Cloud-optimized GeoTIFF"],
		license: "international-meta-wri-chm",
		attribution:
			"Meta and World Resources Institute (WRI) - 2024. High Resolution Canopy Height Maps (CHM). Source imagery " +
			"for CHM © 2016 Maxar. Treetops derived by Mailwoman.",
		attributionURL: "https://registry.opendata.aws/dataforgood-fb-forests/",
		note: "The basemap build derives treetop points from the raster, which adapts it.",
	},
	{
		sourceID: "international-daylight",
		jurisdiction: INTERNATIONAL,
		name: "Daylight Map Distribution landcover",
		publisher: "Daylight Map Distribution",
		datasetURL: "https://daylightmap.org/2023/10/11/landcover.html",
		detail: [StructureDetail.LandCover],
		formats: ["GeoPackage"],
		license: "international-daylight",
		attribution: "Daylight Map Distribution (ODbL), landcover from ESA WorldCover 2020",
		attributionURL: "https://daylightmap.org/attribution.html",
		note: "The Protomaps profile reads it as `daylight-landcover.gpkg` for low-zoom landcover.",
	},
	{
		sourceID: "international-natural-earth",
		jurisdiction: INTERNATIONAL,
		name: "Natural Earth",
		publisher: "Natural Earth",
		datasetURL: "https://www.naturalearthdata.com/",
		detail: [StructureDetail.Cartographic],
		formats: ["GeoPackage"],
		license: "international-natural-earth",
		attribution: "Made with Natural Earth",
		attributionURL: "https://www.naturalearthdata.com/about/terms-of-use/",
		note: "Public domain. The credit is voluntary.",
	},
	{
		sourceID: "international-terrain-tiles",
		jurisdiction: INTERNATIONAL,
		name: "Terrain Tiles (Tilezen Joerd) on AWS",
		publisher: "Mapzen and the Tilezen project",
		datasetURL: "https://registry.opendata.aws/terrain-tiles/",
		detail: [StructureDetail.HeightRaster],
		formats: ["Terrarium PNG"],
		license: "international-terrain-tiles",
		attribution:
			"Terrain: Mapzen; USGS 3DEP, GMTED2010 and SRTM; NOAA ETOPO1; Copernicus EU-DEM; © Commonwealth of Australia " +
			"(Geoscience Australia) 2017; © offene Daten Österreichs; Open Government Licence – Canada; INEGI; " +
			"© Land Information New Zealand; © Kartverket; © Environment Agency 2015; ArcticDEM",
		attributionURL: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
		note: "The hillshade layer reads these tiles directly from `elevation-tiles-prod.s3.amazonaws.com`.",
	},
	{
		sourceID: "international-wikimedia-commons-models",
		jurisdiction: INTERNATIONAL,
		name: "Wikimedia Commons 3D models linked from Wikidata P4896",
		publisher: "Each file's author, as its Commons page states",
		datasetURL: "https://www.wikidata.org/wiki/Property:P4896",
		detail: [StructureDetail.Model],
		formats: ["STL"],
		license: "international-wikimedia-commons-models",
		note:
			"Commons licenses each file separately. This row records the catalog. A model enters a build only under " +
			"its own decision.",
	},
]

/**
 * The license decisions {@link INTERNATIONAL_SOURCES} point at.
 */
export const INTERNATIONAL_LICENSES: readonly LicenseDecision<StructureOperation>[] = [
	{
		licenseID: "international-osm",
		state: LicenseReviewState.Elected,
		electedTerms: "Open Data Commons Open Database License 1.0",
		spdx: "ODbL-1.0",
		retrievedCopy: `${TERMS}/international-osm.md`,
		retrievedAt: RETRIEVED_AT,
		electedBecause: "OpenStreetMap offers one grant.",
		operations: permittedByGrant({
			fetch: "The copyright page grants copying of the data.",
			convert: "The copyright page grants adapting the data.",
			adapt:
				"The copyright page grants adapting the data, and a result built upon it is distributed only under the ODbL.",
			redistribute:
				"The copyright page grants distributing the data with credit to OpenStreetMap and a statement of the ODbL.",
			"commercial-sublicense":
				"The ODbL places no restriction on commercial use. A derivative database stays under the ODbL.",
		}),
	},
	{
		licenseID: "international-overture",
		state: LicenseReviewState.Elected,
		electedTerms: "Open Data Commons Open Database License, as Overture states for the buildings and base themes",
		spdx: "ODbL-1.0",
		retrievedCopy: `${TERMS}/international-overture.md`,
		retrievedAt: RETRIEVED_AT,
		electedBecause:
			"Overture states the ODbL for both themes. Its CC BY 4.0 inputs are credited in the theme attribution lists.",
		operations: permittedByGrant({
			fetch: "Both themes are released under the ODbL, which grants copying.",
			convert: "The ODbL grants adapting the database.",
			adapt: "The ODbL grants adapting the database. A derivative database stays under the ODbL.",
			redistribute: "The ODbL grants distribution with the attribution lists the theme pages give.",
			"commercial-sublicense": "The ODbL places no restriction on commercial use.",
		}),
	},
	{
		licenseID: "international-meta-wri-chm",
		state: LicenseReviewState.Elected,
		electedTerms: "Creative Commons Attribution 4.0 International",
		spdx: "CC-BY-4.0",
		retrievedCopy: `${TERMS}/international-meta-wri-chm.md`,
		retrievedAt: RETRIEVED_AT,
		electedBecause: "The registry entry gives one license.",
		operations: permittedByGrant({
			fetch: "CC BY 4.0 §2(a)(1)(A) grants reproduction.",
			convert: "CC BY 4.0 §2(a)(1)(B) grants producing Adapted Material.",
			adapt: "CC BY 4.0 §2(a)(1)(B) grants producing Adapted Material, here the treetop points.",
			redistribute: "CC BY 4.0 §2(a)(1) grants sharing, conditioned by §3(a) on attribution and a modification note.",
			"commercial-sublicense": "CC BY 4.0 places no restriction on commercial use.",
		}),
	},
	{
		licenseID: "international-daylight",
		state: LicenseReviewState.Elected,
		electedTerms: "Open Data Commons Open Database License",
		spdx: "ODbL-1.0",
		retrievedCopy: `${TERMS}/international-daylight.md`,
		retrievedAt: RETRIEVED_AT,
		electedBecause:
			"The attribution page states the ODbL for the distribution. Its landcover derives from ESA WorldCover 2020, " +
			"which ESA releases under CC BY 4.0 (packages/structures/data/licenses/international-esa-worldcover.md).",
		operations: permittedByGrant({
			fetch: "The ODbL grants copying.",
			convert: "The ODbL grants adapting the database.",
			adapt: "The ODbL grants adapting the database. A derivative database stays under the ODbL.",
			redistribute: "The ODbL grants distribution with the attribution the page lists.",
			"commercial-sublicense": "The ODbL places no restriction on commercial use.",
		}),
	},
	{
		licenseID: "international-natural-earth",
		state: LicenseReviewState.Elected,
		electedTerms: "Public domain, as the Natural Earth terms of use state",
		retrievedCopy: `${TERMS}/international-natural-earth.md`,
		retrievedAt: RETRIEVED_AT,
		electedBecause: "The terms page dedicates every version of the data to the public domain.",
		operations: permittedByGrant({
			fetch: "The data is in the public domain.",
			convert: '"You may use the maps in any manner, including modifying the content and design".',
			adapt: '"You may use the maps in any manner, including modifying the content and design".',
			redistribute: '"No permission is needed to use Natural Earth."',
			"commercial-sublicense": "The data is in the public domain.",
		}),
	},
	{
		licenseID: "international-terrain-tiles",
		state: LicenseReviewState.Unchecked,
		publisherStatement:
			"Each regional input carries its own license: public domain for the USGS and NOAA data, CC BY for Australia, " +
			"Austria, New Zealand and Norway, OGL for Canada and the United Kingdom. The document states none for EU-DEM.",
		note:
			`Read from ${TERMS}/international-terrain-tiles.md. The EU-DEM input states no license, so the tiles cannot ` +
			"be elected as a whole. The map credits every listed input meanwhile.",
	},
	{
		licenseID: "international-wikimedia-commons-models",
		state: LicenseReviewState.Unchecked,
		publisherStatement: "Licensed per file, under terms each file page states.",
		note: RESEARCH_HANDOFF_NOTE,
	},
]
