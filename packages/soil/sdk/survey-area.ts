/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One survey area's attributes, its own metadata, and its mapped footprint.
 *
 *   THE FOOTPRINT IS THE SURVEY-AREA OUTLINE, NEVER THE UNION OF THE RATED POLYGONS. `NOTCOM`,
 *   access-denied and `NOTPUB` map units are INSIDE the footprint and carry no rating, so a footprint taken
 *   from the rated set would report them as unmapped when the authority has declared exactly what they are.
 *   The archive ships the outline as its own shapefile — `soilsa_a_<areasymbol>.shp`, one feature — which is
 *   why this layer never has to reconstruct it.
 *
 *   THE REFRESH DATE IS NOT THE SURVEY DATE, AND CONFLATING THEM IS THE CURRENCY LIE THIS FILE EXISTS TO
 *   PREVENT. `IA153` carries `saverest` 2025-09-09 and version 28, and the FGDC lineage inside the same
 *   archive cites `Soil Survey of Polk County, Iowa`, 1:15,840, **1960**. The dataset's own
 *   time-period-of-content runs 1998-09-22 to 2025-09-09, so a consumer reading that as survey currency
 *   reads it wrong by sixty-five years. Both dates are stored, apart, with the title the older one came
 *   from so it is checkable rather than assertible.
 *
 *   TWO SCALES, ALSO DIFFERENT FACTS. `legend.projectscale` is 12,000 for `IA153` — the scale the map units
 *   were digitized at. The 1960 source citation's own `srcscale` is 15,840 — the scale the ground was
 *   walked at. Storing one as the other would answer the enlargement caveat's question wrongly.
 *
 *   THE LICENCE IS CHECKED PER SURVEY AREA, against the `useconst` element of the metadata that area ships.
 *   An area whose use constraints no longer say "This is public information" is a licence change, and a
 *   build that absorbed one would ship an artifact under terms nobody checked. The text is boilerplate
 *   repeated across SSURGO, which is why asserting it is cheap and why a change in it is loud.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { execFile } from "@mailwoman/platform/child_process"
import { promisify } from "@mailwoman/platform/util"
import type { GeojsonGeometry } from "@mailwoman/spatial"

import type { SoilComponentTable, SoilMapUnitTable } from "../schema.ts"
import {
	COINTERP_OVERALL_RULE_DEPTH,
	farmlandScope,
	NCCPI_V3_RULE_NAME,
	SSURGO_NO_MAPPING_NAMES,
	SSURGO_NO_MAPPING_SYMBOLS,
	SSURGO_PUBLIC_INFORMATION_SENTENCE,
} from "../vocabulary.ts"
import { domainCodes, readDeclaredDomains, readTable, readTabularDictionary, type DomainMember } from "./tabular.ts"

const execFileAsync = promisify(execFile)

/**
 * The declared domains this layer validates against, and stores.
 *
 * `capability_class` is shared by `nirrcapcl`, `irrcapcl` and `muaggatt.niccdcd`, which is why one domain covers three
 * columns.
 */
export const STORED_DOMAINS = [
	"capability_class",
	"capability_subclass",
	"farmland_classification",
	"component_kind",
	"mapunit_kind",
	"mapunit_status",
] as const

/**
 * One survey area's tabular attributes, already joined and validated.
 */
export interface SurveyAreaAttributes {
	areasymbol: string
	areaname: string
	saverest: string
	saversion: number | null
	surveySourceDate: string | null
	surveySourceTitle: string | null
	sourceScale: number | null
	mappingScale: number | null
	/**
	 * The area the authority publishes for this survey area, in acres — the independent witness the ring-area check
	 * compares against.
	 */
	areaAcres: number | null
	mapUnits: SoilMapUnitTable[]
	components: SoilComponentTable[]
	domains: DomainMember[]
}

/**
 * Read one survey area's tabular export.
 *
 * @throws {Error} When the metadata's use constraints no longer carry the public-information sentence, when a `Choice`
 *   column holds a value outside the authority's own declared domain, or when the export declares no legend row.
 */
export async function readSurveyAreaAttributes(
	tabularDirectory: string,
	areaSymbol: string
): Promise<SurveyAreaAttributes> {
	const dictionary = await readTabularDictionary(tabularDirectory)
	const domains = await readDeclaredDomains(tabularDirectory)

	const catalog = await readTable(tabularDirectory, dictionary, "sacatalog", [
		"areasymbol",
		"areaname",
		"saverest",
		"saversion",
		"fgdcmetadata",
	])

	if (catalog.rows.length !== 1) {
		throw new Error(
			`soil survey area: ${areaSymbol}'s sacatlog.txt holds ${catalog.rows.length} records, expected 1 — a survey-area archive describes exactly one survey area`
		)
	}

	const catalogRow = catalog.rows[0]!
	const metadata = readFGDCMetadata(catalogRow.fgdcmetadata!, areaSymbol)

	const legend = await readTable(tabularDirectory, dictionary, "legend", [
		"areasymbol",
		"areaname",
		"areaacres",
		"projectscale",
	])

	if (!legend.rows.length) {
		throw new Error(`soil survey area: ${areaSymbol}'s legend.txt holds no record, so the published area is unknown`)
	}

	const legendRow = legend.rows.find((row) => row.areasymbol === areaSymbol) ?? legend.rows[0]!

	const mapUnitRows = await readTable(tabularDirectory, dictionary, "mapunit", [
		"mukey",
		"musym",
		"muname",
		"mukind",
		"mustatus",
		"farmlndcl",
	])

	const aggregate = await readTable(tabularDirectory, dictionary, "muaggatt", ["mukey", "niccdcd", "niccdcdpct"])
	const aggregateByMukey = new Map(aggregate.rows.map((row) => [row.mukey!, row]))

	const componentRows = await readTable(tabularDirectory, dictionary, "component", [
		"cokey",
		"mukey",
		"comppct_r",
		"compname",
		"compkind",
		"nirrcapcl",
		"nirrcapscl",
		"irrcapcl",
		"irrcapscl",
	])

	const nccpiByCokey = await readNCCPI(tabularDirectory, dictionary)

	const classCodes = domainCodes(domains, "capability_class")
	const subclassCodes = domainCodes(domains, "capability_subclass")
	const componentKinds = domainCodes(domains, "component_kind")
	const farmlandCodes = domainCodes(domains, "farmland_classification")
	const mapUnitKinds = domainCodes(domains, "mapunit_kind")

	const componentsByMukey = new Map<string, number>()

	const components: SoilComponentTable[] = componentRows.rows.map((row) => {
		assertDeclared(classCodes, row.nirrcapcl, "capability_class", `component ${row.cokey}.nirrcapcl`)
		assertDeclared(classCodes, row.irrcapcl, "capability_class", `component ${row.cokey}.irrcapcl`)
		assertDeclared(subclassCodes, row.nirrcapscl, "capability_subclass", `component ${row.cokey}.nirrcapscl`)
		assertDeclared(subclassCodes, row.irrcapscl, "capability_subclass", `component ${row.cokey}.irrcapscl`)
		assertDeclared(componentKinds, row.compkind, "component_kind", `component ${row.cokey}.compkind`)

		componentsByMukey.set(row.mukey!, (componentsByMukey.get(row.mukey!) ?? 0) + 1)

		return {
			cokey: row.cokey!,
			mukey: row.mukey!,
			// A blank `comppct_r` is a component with no declared weight. Zero is the truthful reading — it contributes
			// nothing to a weighted share — and it is recorded rather than dropped, so the component still appears.
			comppct_r: row.comppct_r ? Number(row.comppct_r) : 0,
			compname: nullable(row.compname),
			compkind: nullable(row.compkind),
			nirrcapcl: nullable(row.nirrcapcl),
			nirrcapscl: nullable(row.nirrcapscl),
			irrcapcl: nullable(row.irrcapcl),
			irrcapscl: nullable(row.irrcapscl),
			nccpi_v3: nccpiByCokey.get(row.cokey!) ?? null,
		}
	})

	const mapUnits: SoilMapUnitTable[] = mapUnitRows.rows.map((row) => {
		assertDeclared(farmlandCodes, row.farmlndcl, "farmland_classification", `map unit ${row.mukey}.farmlndcl`)
		assertDeclared(mapUnitKinds, row.mukind, "mapunit_kind", `map unit ${row.mukey}.mukind`)

		const aggregated = aggregateByMukey.get(row.mukey!)

		assertDeclared(classCodes, aggregated?.niccdcd, "capability_class", `map unit ${row.mukey}.niccdcd`)

		return {
			mukey: row.mukey!,
			areasymbol: areaSymbol,
			musym: row.musym!,
			muname: row.muname!,
			mukind: nullable(row.mukind),
			mustatus: nullable(row.mustatus),
			farmlndcl: nullable(row.farmlndcl),
			farmland_scope: farmlandScope(row.farmlndcl),
			niccdcd: nullable(aggregated?.niccdcd),
			niccdcdpct: aggregated?.niccdcdpct ? Number(aggregated.niccdcdpct) : null,
			no_mapping: isNoMapping(row.musym!, row.muname!, componentsByMukey.get(row.mukey!) ?? 0) ? 1 : 0,
		}
	})

	return {
		areasymbol: areaSymbol,
		areaname: legendRow.areaname || catalogRow.areaname!,
		saverest: metadata.publicationDate,
		saversion: catalogRow.saversion ? Number(catalogRow.saversion) : null,
		surveySourceDate: metadata.oldestSourceDate,
		surveySourceTitle: metadata.oldestSourceTitle,
		sourceScale: metadata.oldestSourceScale,
		mappingScale: legendRow.projectscale ? Number(legendRow.projectscale) : null,
		areaAcres: legendRow.areaacres ? Number(legendRow.areaacres) : null,
		mapUnits,
		components,
		domains: domains.filter((member) => (STORED_DOMAINS as ReadonlyArray<string>).includes(member.domain)),
	}
}

/**
 * A polygon the authority drew with no soil mapping behind it.
 *
 * Three signals rather than one, because the source encodes the same fact three ways and each on its own has a gap: the
 * symbol (`NOTCOM`, `NOTPUB`), the name (`Area not surveyed, access denied`), and the structural case of a map unit
 * carrying NO components at all. A map unit with no components has nothing to rate whatever it is called, and reading
 * it as "rated nothing" rather than "no mapping" would put it in `unrated_share` — a claim that the survey looked and
 * declined, when it did not look.
 */
function isNoMapping(musym: string, muname: string, componentCount: number): boolean {
	if (SSURGO_NO_MAPPING_SYMBOLS.has(musym.toUpperCase())) return true

	if (SSURGO_NO_MAPPING_NAMES.has(muname.trim().toLowerCase())) return true

	return componentCount === 0
}

/**
 * Refuse a value outside the authority's own declared domain.
 *
 * An unknown code is a source-schema change, which is the event a reader most needs to hear about; coercing it to a
 * nearest neighbour or to NULL converts "the source changed" into "there is nothing here". A BLANK is not a violation:
 * NULL is a real state in every one of these columns and means something specific — for `nirrcapcl` it means the survey
 * did not rate the component, which is not class 8.
 */
function assertDeclared(declared: ReadonlySet<string>, value: string | undefined, domain: string, where: string): void {
	if (!value) return

	if (declared.has(value)) return

	throw new Error(
		`soil survey area: ${where} holds ${JSON.stringify(value)}, which is not in the authority's declared ${domain} domain (${declared.size} members, read from the archive's own msdomdet.txt) — an unknown code is a source-schema change, and coercing it would turn "the source changed" into "there is nothing here"`
	)
}

function nullable(value: string | undefined): string | null {
	return value || null
}

/**
 * The NCCPI v3.0 overall index per component.
 *
 * `cointerp` is the largest table in the export — 157,063 rows for `IA153`, read in 0.36 s — and the overall rule is
 * one row per component at {@link COINTERP_OVERALL_RULE_DEPTH}: 369 of 369 components on `IA153`, of which 327 carry a
 * value. Sub-rules at greater depths are the submodels (corn, soybeans, small grains, cotton), which this layer does
 * not carry.
 */
async function readNCCPI(
	tabularDirectory: string,
	dictionary: Awaited<ReturnType<typeof readTabularDictionary>>
): Promise<Map<string, number>> {
	const rows = await readTable(tabularDirectory, dictionary, "cointerp", [
		"cokey",
		"mrulename",
		"ruledepth",
		"interphr",
	])

	const byCokey = new Map<string, number>()

	for (const row of rows.rows) {
		if (row.mrulename !== NCCPI_V3_RULE_NAME) continue

		if (row.ruledepth !== COINTERP_OVERALL_RULE_DEPTH) continue

		if (!row.interphr) continue

		byCokey.set(row.cokey!, Number(row.interphr))
	}

	return byCokey
}

/**
 * What the shipped FGDC metadata says about this survey area's dates and its licence.
 */
export interface FGDCMetadata {
	/**
	 * The citation's own `pubdate`, as an ISO date — the refresh.
	 */
	publicationDate: string
	/**
	 * The OLDEST source citation date in the lineage, as an ISO date or a bare year.
	 */
	oldestSourceDate: string | null
	oldestSourceTitle: string | null
	oldestSourceScale: number | null
}

/**
 * Read the metadata NRCS ships inside the archive.
 *
 * Targeted extraction rather than a general XML parse: the document is regular, this reader wants five values out of
 * it, and adding an XML parser to the dependency graph to read `<pubdate>` would be the larger change. Every value it
 * cannot find is reported as `null` EXCEPT the publication date and the licence sentence, which throw — those two
 * decide the artifact's vintage and whether it may be shipped at all, and neither has a safe default.
 *
 * @throws {Error} When the metadata carries no publication date, or its use constraints no longer carry the
 *   public-information sentence.
 */
export function readFGDCMetadata(xml: string, areaSymbol: string): FGDCMetadata {
	const useConstraints = elementText(xml, "useconst")

	if (!useConstraints?.includes(SSURGO_PUBLIC_INFORMATION_SENTENCE)) {
		throw new Error(
			`soil survey area: ${areaSymbol}'s FGDC use constraints do not carry ${JSON.stringify(SSURGO_PUBLIC_INFORMATION_SENTENCE)} — that sentence is the grant this layer ships on, so a survey area without it must not be built into a distributable artifact`
		)
	}

	const publicationDate = elementText(xml, "pubdate")

	if (!publicationDate) {
		throw new Error(
			`soil survey area: ${areaSymbol}'s FGDC metadata carries no publication date — stamping the artifact with a guessed vintage would give it a version that means nothing`
		)
	}

	const sources = readSourceCitations(xml)
	const oldest = sources.toSorted((left, right) => (left.date < right.date ? -1 : 1))[0]

	return {
		publicationDate: normalizeFGDCDate(publicationDate),
		oldestSourceDate: oldest ? normalizeFGDCDate(oldest.date) : null,
		oldestSourceTitle: oldest?.title ?? null,
		oldestSourceScale: oldest?.scale ?? null,
	}
}

/**
 * The lineage's source citations: what the polygons rest on, and when each was made.
 */
function readSourceCitations(xml: string): Array<{ date: string; title: string; scale: number | null }> {
	const citations: Array<{ date: string; title: string; scale: number | null }> = []

	for (const body of elementBlocks(xml, "srcinfo")) {
		// `caldate` for a single date, `begdate` for a range. A range's END is when the source stopped being collected;
		// its BEGINNING is when the ground was first looked at, which is the fact this layer is carrying.
		const date = elementText(body, "caldate") ?? elementText(body, "begdate")

		if (!date) continue

		const scale = elementText(body, "srcscale")

		citations.push({
			date: date.trim(),
			title: (elementText(body, "title") ?? "").replaceAll(/\s+/gu, " ").trim(),
			scale: scale ? Number(scale) : null,
		})
	}

	return citations
}

/**
 * The text of the first `<name>` element, whitespace left alone.
 *
 * INDEX SCANS RATHER THAN A REGEX, AND THAT IS A CORRECTNESS CHOICE RATHER THAN A SPEED ONE. The obvious form — ``new
 * RegExp(`<${name}>([\\s\\S]*?)</${name}>`)`` — backtracks polynomially on a document whose opening tag has no closing
 * partner: the lazy run re-scans to the end from every candidate start. The input here is a 43,251-character document
 * that arrived over the network inside a downloaded archive, so "a malformed one cannot happen" is not a claim this
 * reader gets to make. Two `indexOf` calls answer the same question in one pass.
 */
function elementText(xml: string, name: string): string | undefined {
	const open = `<${name}>`
	const start = xml.indexOf(open)

	if (start === -1) return undefined

	const from = start + open.length
	const end = xml.indexOf(`</${name}>`, from)

	// An element with no closing tag is unreadable, not empty — the same answer an absent element gets, because both
	// mean the value could not be read rather than that it is blank.
	return end === -1 ? undefined : xml.slice(from, end)
}

/**
 * Every `<name>` element's inner text, in document order. The repeating counterpart of {@link elementText}, and linear
 * for the same reason.
 */
function elementBlocks(xml: string, name: string): string[] {
	const open = `<${name}>`
	const close = `</${name}>`
	const blocks: string[] = []

	let cursor = 0

	for (;;) {
		const start = xml.indexOf(open, cursor)

		if (start === -1) return blocks

		const from = start + open.length
		const end = xml.indexOf(close, from)

		if (end === -1) return blocks

		blocks.push(xml.slice(from, end))
		cursor = end + close.length
	}
}

/**
 * FGDC dates arrive as `YYYY` or `YYYYMMDD`. Both are kept as they are meant — a bare year is a bare year, and padding
 * it to January 1 would invent a precision the citation does not claim.
 */
function normalizeFGDCDate(value: string): string {
	const trimmed = value.trim()
	const matched = /^(\d{4})(\d{2})(\d{2})$/u.exec(trimmed)

	return matched ? `${matched[1]}-${matched[2]}-${matched[3]}` : trimmed
}

/**
 * Read the survey area's own outline shapefile as a GeoJSON geometry.
 *
 * @throws {Error} When the shapefile holds anything other than exactly one feature. Taking the first of several would
 *   silently choose which ground the coverage claim is about.
 */
export async function readSurveyAreaOutline(shapefilePath: string): Promise<GeojsonGeometry> {
	const { stdout } = await execFileAsync(
		"ogr2ogr",
		["-f", "GeoJSON", "/vsistdout/", "-t_srs", "EPSG:4326", shapefilePath],
		{ maxBuffer: 256 * 1024 * 1024 }
	)

	const collection = parseJSONStrict<{ features?: Array<{ geometry?: GeojsonGeometry }> }>(stdout)
	const features = collection.features ?? []

	if (features.length !== 1) {
		throw new Error(
			`soil survey area: ${shapefilePath} holds ${features.length} features, expected exactly 1 — a survey area publishes one outline, and taking the first of several would silently choose which ground the coverage claim is about`
		)
	}

	const geometry = features[0]!.geometry

	if (!geometry) {
		throw new Error(`soil survey area: ${shapefilePath}'s single feature carries no geometry`)
	}

	return geometry
}
