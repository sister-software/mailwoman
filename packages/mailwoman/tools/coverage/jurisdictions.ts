/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The jurisdiction coverage layer: one Natural Earth map unit per jurisdiction, carrying what a
 *   training run drew from it, the address sources the register holds for it, its address system,
 *   and its board rows.
 *
 *   The training numbers come from a run's realized-draws exposure report, the rows the trainer
 *   actually drew, rather than from a corpus census. A census counts rows a run may never sample.
 */

import {
	ingestEligibilityProblems,
	readAddressSourceRegister,
	type AddressSourceRegister,
} from "@mailwoman/corpus/source-register"
import { readLocalJSONFile, statPath } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { dirname, type PathBuilderLike } from "path-ts"
import { $ } from "zx"

import { readAdmittedCountries, readBoardCoverage } from "#tools/coverage/census"
import {
	mapUnitJurisdiction,
	type NaturalEarthUnit,
	NATURAL_EARTH_RELEASE,
} from "#tools/coverage/natural-earth"
import type { AddressSystemRegistry } from "#tools/dev-tools/codex/address/systems"

/**
 * The source-layer name the jurisdiction tiles use.
 */
export const JURISDICTION_SOURCE_LAYER = "jurisdictions"

/**
 * The unary phenomena whose forms the layer counts, from the exposure report's `phenomena` section.
 */
const SHAPE_PHENOMENA = [
	"postcode-precedes-locality",
	"house-number-precedes-street",
	"largest-unit-first",
	"streetless-premise-identity",
	"premise-subdivision-present",
	"fixed-width-numeric-postcode",
] as const

/**
 * One jurisdiction's entry in an exposure report, as far as the layer reads it.
 */
export interface ExposureJurisdiction {
	stages: { realized_draws: { total: number } | null }
	phenomena: Record<string, { realized_draws: Record<string, number> | null }>
}

/**
 * The parts of a `mailwoman.exposure/v1` report the layer reads.
 */
export interface ExposureReport {
	schema: string
	inputs: { output_dir?: string; corpus_dir?: string }
	jurisdictions: Record<string, ExposureJurisdiction>
	address_systems: { systems: Array<{ id: number; rows: { realized_draws?: number } }> }
}

/**
 * The properties one jurisdiction feature holds.
 *
 * A measure with no reading is omitted rather than written as zero, because a vector
 * tile property cannot hold null and zero is a reading.
 */
export interface JurisdictionProperties {
	[key: string]: string | number | boolean
	iso2: string
	name: string
	/**
	 * Rows the training run drew from the jurisdiction.
	 */
	draws: number
	/**
	 * The jurisdiction's draws over all the run's draws.
	 */
	draw_share: number
	/**
	 * Whether the run's config admits the jurisdiction.
	 */
	admitted: boolean
	/**
	 * Distinct address-shape forms among the drawn rows, such as `postcode-precedes-locality=before`.
	 */
	shape_forms: number
	/**
	 * Sources the register lists for the jurisdiction, and how many of them may enter a corpus.
	 */
	sources: number
	eligible_sources: number
	/**
	 * The register's backbone state, A through D.
	 */
	backbone: string
	board_rows: number
	board_checking_rows: number
}

/**
 * A register source count for one jurisdiction: all its sources, and those
 * with no ingest-eligibility problem.
 */
export interface JurisdictionSourceCount {
	total: number
	eligible: number
}

/**
 * Everything one jurisdiction feature is built from.
 */
export interface JurisdictionInputs {
	exposure: ExposureReport
	jurisdictions: ReadonlyArray<Pick<AddressSourceRegister["jurisdictions"][number], "iso2" | "name" | "backboneState">>
	sources: ReadonlyMap<string, JurisdictionSourceCount>
	systems: AddressSystemRegistry
	admitted: ReadonlySet<string>
	board: ReadonlyMap<string, { rows: number; passed: number }>
}

/**
 * Counts each jurisdiction's register sources and the ones `ingestEligibilityProblems` finds no problem with.
 */
export function countRegisterSources(register: AddressSourceRegister): Map<string, JurisdictionSourceCount> {
	const counts = new Map<string, JurisdictionSourceCount>()

	for (const source of register.sources) {
		const count = counts.get(source.iso2) ?? { total: 0, eligible: 0 }

		count.total++

		if (!ingestEligibilityProblems(source, register).length) { count.eligible++ }

		counts.set(source.iso2, count)
	}

	return counts
}

/**
 * The share of `numerator` among `numerator + other`, rounded to three places,
 * or `null` when both are zero.
 */
function share(numerator: number, other: number): number | null {
	const total = numerator + other

	return total > 0 ? Math.round((numerator / total) * 1000) / 1000 : null
}

/**
 * Builds the properties of every jurisdiction the register enumerates, keyed by ISO alpha-2 code.
 */
export function jurisdictionProperties(inputs: JurisdictionInputs): Map<string, JurisdictionProperties> {
	const totalDraws = Object.values(inputs.exposure.jurisdictions).reduce(
		(sum, entry) => sum + (entry.stages.realized_draws?.total ?? 0),
		0
	)

	const systemDraws = new Map(
		inputs.exposure.address_systems.systems.map((system) => [system.id, system.rows.realized_draws ?? 0])
	)

	const systemKeys = new Map(inputs.systems.systems.map((system) => [system.id, system.key]))

	const localSystem = new Map(
		inputs.systems.members
			.filter((member) => member.script === "local")
			.map((member) => [member.country, member.system])
	)

	const result = new Map<string, JurisdictionProperties>()

	for (const jurisdiction of inputs.jurisdictions) {
		const code = jurisdiction.iso2
		const exposure = inputs.exposure.jurisdictions[code]
		const draws = exposure?.stages.realized_draws?.total ?? 0
		const sources = inputs.sources.get(code)
		const board = inputs.board.get(code)

		const forms = SHAPE_PHENOMENA.flatMap((phenomenon) =>
			Object.entries(exposure?.phenomena[phenomenon]?.realized_draws ?? {}).filter(([, count]) => count > 0)
		)

		const properties: JurisdictionProperties = {
			iso2: code,
			name: jurisdiction.name,
			draws,
			draw_share: totalDraws > 0 ? draws / totalDraws : 0,
			admitted: inputs.admitted.has(code),
			shape_forms: forms.length,
			sources: sources?.total ?? 0,
			eligible_sources: sources?.eligible ?? 0,
			backbone: jurisdiction.backboneState,
			board_rows: board?.rows ?? 0,
			board_checking_rows: board?.passed ?? 0,
		}

		const postcode = exposure?.phenomena["postcode-precedes-locality"]?.realized_draws
		const postcodeFirst = share(postcode?.["before"] ?? 0, postcode?.["after"] ?? 0)

		if (postcodeFirst !== null) { properties["postcode_first_share"] = postcodeFirst }

		const houseNumber = exposure?.phenomena["house-number-precedes-street"]?.realized_draws
		const houseNumberFirst = share(houseNumber?.["before"] ?? 0, houseNumber?.["after"] ?? 0)

		if (houseNumberFirst !== null) { properties["house_number_first_share"] = houseNumberFirst }

		const system = localSystem.get(code)

		if (system !== undefined) {
			properties["address_system"] = system
			properties["address_system_key"] = systemKeys.get(system) ?? ""
			properties["address_system_draws"] = systemDraws.get(system) ?? 0
		}

		result.set(code, properties)
	}

	return result
}

/**
 * Joins the properties onto the map units.
 *
 * A unit no register jurisdiction owns is left out and counted, and each
 * jurisdiction with no unit is listed.
 */
export function jurisdictionFeatures(
	units: readonly NaturalEarthUnit[],
	properties: ReadonlyMap<string, JurisdictionProperties>
): {
	features: Array<{ type: "Feature"; properties: JurisdictionProperties; geometry: NaturalEarthUnit["geometry"] }>
	unownedUnits: string[]
	unmappedJurisdictions: string[]
} {
	const features = []
	const unownedUnits: string[] = []
	const mapped = new Set<string>()

	for (const unit of units) {
		const code = mapUnitJurisdiction(unit.properties)
		const entry = code ? properties.get(code) : undefined

		if (!code || !entry) {
			unownedUnits.push(unit.properties.NAME)

			continue
		}

		mapped.add(code)
		features.push({ type: "Feature" as const, properties: entry, geometry: unit.geometry })
	}

	return {
		features,
		unownedUnits,
		unmappedJurisdictions: [...properties.keys()].filter((code) => !mapped.has(code)).toSorted(),
	}
}

/**
 * Configures `buildJurisdictionTiles`.
 */
export interface JurisdictionTileOptions {
	/**
	 * The Natural Earth map units, from `fetchNaturalEarthFile`.
	 */
	units: readonly NaturalEarthUnit[]
	/**
	 * A realized-draws exposure report from a training run's checkpoint directory.
	 */
	exposurePath: PathBuilderLike
	/**
	 * The training config whose `country_weights` decides admission.
	 */
	configPath: PathBuilderLike
	casesRoot: PathBuilderLike
	systems: AddressSystemRegistry
	out: PathBuilderLike
	maxZoom: number
}

/**
 * The result of a jurisdiction tile build.
 */
export interface JurisdictionTileResult {
	out: string
	features: number
	jurisdictions: number
	unownedUnits: string[]
	unmappedJurisdictions: string[]
	pmtilesBytes: number
}

/**
 * Builds the jurisdiction coverage PMTiles.
 *
 * @throws When the exposure report is not a `mailwoman.exposure/v1` report, or tippecanoe fails.
 */
export async function buildJurisdictionTiles(options: JurisdictionTileOptions): Promise<JurisdictionTileResult> {
	const exposure = await readLocalJSONFile<ExposureReport>(options.exposurePath)

	if (exposure.schema !== "mailwoman.exposure/v1") {
		throw new Error(`${options.exposurePath}: expected a mailwoman.exposure/v1 report, got ${exposure.schema}`)
	}

	const register = await readAddressSourceRegister()

	const properties = jurisdictionProperties({
		exposure,
		jurisdictions: register.jurisdictions,
		sources: countRegisterSources(register),
		systems: options.systems,
		admitted: await readAdmittedCountries(options.configPath),
		board: await readBoardCoverage(options.casesRoot),
	})

	const joined = jurisdictionFeatures(options.units, properties)
	const geojsonPath = `${options.out}.geojson`

	await makeDirectories(dirname(options.out))
	await writeLocalJSONFile({ type: "FeatureCollection", features: joined.features }, geojsonPath)

	const tip = await $({ nothrow: true, quiet: true })`tippecanoe ${[
		"-o",
		String(options.out),
		"-l",
		JURISDICTION_SOURCE_LAYER,
		"-n",
		"Mailwoman jurisdiction coverage",
		"-A",
		`Natural Earth ${NATURAL_EARTH_RELEASE} (public domain) · Sister Software`,
		"--minimum-zoom",
		"0",
		"--maximum-zoom",
		String(options.maxZoom),
		"--detect-shared-borders",
		"--no-tile-size-limit",
		"--no-progress-indicator",
		"--force",
		geojsonPath,
	]}`

	if (tip.exitCode !== 0) {
		throw new Error(`tippecanoe exited ${tip.exitCode}: ${tip.stderr.slice(-400)}`)
	}

	return {
		out: String(options.out),
		features: joined.features.length,
		jurisdictions: properties.size,
		unownedUnits: joined.unownedUnits,
		unmappedJurisdictions: joined.unmappedJurisdictions,
		pmtilesBytes: (await statPath(options.out)).size,
	}
}
