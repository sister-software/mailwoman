/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import { normalizeWhitespace } from "@mailwoman/core/strings/format"
import type { ParsedGeometry } from "@mailwoman/spatial"
import type { PathBuilderLike } from "path-ts"

import type { SoilComponentTable, SoilMapUnitTable } from "#schema"
import { domainCodes, readDeclaredDomains, readTable, readTabularDictionary, type DomainMember } from "#sdk/tabular"
import {
	COINTERP_OVERALL_RULE_DEPTH,
	farmlandScope,
	NCCPI_V3_RULE_NAME,
	SSURGO_NO_MAPPING_NAMES,
	SSURGO_NO_MAPPING_SYMBOLS,
	SSURGO_PUBLIC_INFORMATION_SENTENCE,
} from "#vocabulary"

/**
 * The declared domains this layer validates against and stores; `capability_class`
 * covers `nirrcapcl`, `irrcapcl` and `muaggatt.niccdcd`.
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
	 * The area the authority publishes for this survey area, in acres —
	 * the independent witness the ring-area check compares against.
	 */
	areaAcres: number | null
	mapUnits: SoilMapUnitTable[]
	components: SoilComponentTable[]
	domains: DomainMember[]
}

/**
 * Read one survey area's tabular export.
 *
 * @throws {Error} When the metadata's use constraints no longer carry the public-information
 * sentence, when a `Choice` column holds a value outside the authority's own declared
 * domain, or when the export declares no legend row.
 */
export async function readSurveyAreaAttributes(
	tabularDirectory: PathBuilderLike,
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
			// A blank `comppct_r` is a component with no declared weight, recorded as zero
			// rather than dropped so the component still appears.
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
 * A map unit with no components has no component to rate, so it reads as no mapping
 * rather than assigned no rating.
 */
function isNoMapping(musym: string, muname: string, componentCount: number): boolean {
	if (SSURGO_NO_MAPPING_SYMBOLS.has(musym.toUpperCase())) return true

	if (SSURGO_NO_MAPPING_NAMES.has(muname.trim().toLowerCase())) return true

	return componentCount === 0
}

/**
 * Refuse a value outside the authority's own declared domain.
 *
 * A blank is a real NULL state rather than a violation, recording that the
 * survey did not rate the component.
 */
function assertDeclared(declared: ReadonlySet<string>, value: string | undefined, domain: string, where: string): void {
	if (!value) return

	if (declared.has(value)) return

	throw new Error(
		`soil survey area: ${where} holds ${stringifyJSON(value)}, which is not in the authority's declared ${domain} domain (${declared.size} members, read from the archive's own msdomdet.txt) — an unknown code is a source-schema change, and coercing it would turn "the source changed" into "there is nothing here"`
	)
}

function nullable(value: string | undefined): string | null {
	return value || null
}

/**
 * The nccpi v3.0 overall index per component.
 *
 * Sub-rules at greater depths are submodels this layer does not carry.
 */
async function readNCCPI(
	tabularDirectory: PathBuilderLike,
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
 * What the shipped fgdc metadata says about this survey area's dates and its licence.
 */
export interface FGDCMetadata {
	/**
	 * The citation's own `pubdate` as an ISO date — the refresh rather than the survey date.
	 */
	publicationDate: string
	/**
	 * The oldest source citation date in the lineage, as an ISO date or a bare year.
	 */
	oldestSourceDate: string | null
	oldestSourceTitle: string | null
	oldestSourceScale: number | null
}

/**
 * Read the metadata nrcs ships inside the archive.
 *
 * @throws {Error} When the metadata carries no publication date, or its use
 * constraints no longer carry the public-information sentence.
 */
export function readFGDCMetadata(xml: string, areaSymbol: string): FGDCMetadata {
	const useConstraints = elementText(xml, "useconst")

	if (!useConstraints?.includes(SSURGO_PUBLIC_INFORMATION_SENTENCE)) {
		throw new Error(
			`soil survey area: ${areaSymbol}'s FGDC use constraints do not carry ${stringifyJSON(SSURGO_PUBLIC_INFORMATION_SENTENCE)} — that sentence is the grant this layer ships on, so a survey area without it must not be built into a distributable artifact`
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
 * The lineage's source citations — what the polygons rest on and when each was made.
 */
function readSourceCitations(xml: string): Array<{ date: string; title: string; scale: number | null }> {
	const citations: Array<{ date: string; title: string; scale: number | null }> = []

	for (const body of elementBlocks(xml, "srcinfo")) {
		// `caldate` for a single date, `begdate` for a range, whose beginning is the date this layer carries.
		const date = elementText(body, "caldate") ?? elementText(body, "begdate")

		if (!date) continue

		const scale = elementText(body, "srcscale")

		citations.push({
			date: date.trim(),
			title: normalizeWhitespace(elementText(body, "title") ?? ""),
			scale: scale ? Number(scale) : null,
		})
	}

	return citations
}

/**
 * The text of the first `<name>` element, whitespace left alone.
 *
 * Two `indexOf` calls avoid the polynomial backtracking a regex takes on a document
 * whose opening tag has no closing partner.
 */
function elementText(xml: string, name: string): string | undefined {
	const open = `<${name}>`
	const start = xml.indexOf(open)

	if (start === -1) return undefined

	const from = start + open.length
	const end = xml.indexOf(`</${name}>`, from)

	// An element with no closing tag is unreadable rather than empty, the same answer an absent element gets.
	return end === -1 ? undefined : xml.slice(from, end)
}

/**
 * Every `<name>` element's inner text in document order, the repeating counterpart of {@link elementText}.
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
 * A bare year stays bare, since padding it to January 1 would invent a precision
 * the citation does not claim.
 */
function normalizeFGDCDate(value: string): string {
	const trimmed = value.trim()
	const matched = /^(\d{4})(\d{2})(\d{2})$/u.exec(trimmed)

	return matched ? `${matched[1]}-${matched[2]}-${matched[3]}` : trimmed
}

/**
 * Read the survey area's own outline shapefile as a GeoJSON geometry.
 *
 * @throws {Error} When the shapefile holds anything other than exactly one feature.
 * Taking the first of several would silently choose which ground the coverage claim is about.
 */
export async function readSurveyAreaOutline(shapefilePath: PathBuilderLike): Promise<ParsedGeometry> {
	const { stdout } = await runFile("ogr2ogr", ["-f", "GeoJSON", "/vsistdout/", "-t_srs", "EPSG:4326", shapefilePath], {
		maxBuffer: 256 * 1024 * 1024,
	})

	const collection = parseJSONStrict<{ features?: Array<{ geometry?: ParsedGeometry }> }>(stdout)
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
