/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Samples cross-source address-point pairs from a built address layer for adjudication.
 *
 *   A pair joins a row from a higher-ranked source with a row from a lower-ranked one: `usgov-nad`, then the
 *   OpenAddresses runs read directly, then Overture's datasets. Pairs come from two kinds of key group. A postcode
 *   key group holds rows that share a postcode, street key and house number. A locality key group holds rows that
 *   share a locality, street key and number but state different postcodes. A wrong postcode on one side shows there.
 *
 *   Each pair lands in one stratum by its failure shape. Each stratum is capped per region, so every region in the
 *   run contributes pairs and the densest region cannot fill a stratum. Every row stores both records in full, the measured
 *   evidence (the distance, each unit's identifier, each point's stack size) and the verdict of the deterministic rule
 *   the layer build applies. The adjudication fields stay `null` for a human or a flagged LLM judge to fill.
 *
 *   Run: `mailwoman registry address-pair-sample --layer-version 2026-11-08 [--regions us-ny,us-co] [--per-stratum 60]
 *   [--seed 1] --out-jsonl <path>`
 */

import { usUnitIdentifier } from "@mailwoman/codex/us/unit/designator"
import { hashFNV1a } from "@mailwoman/core/coarse-placer/fnv-hash"
import { writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { addressLayerFiles } from "@mailwoman/resolver-wof-sqlite/address/keys/layout"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

/**
 * The failure shapes a pair is sampled by, in the order a pair is assigned to them.
 */
export const AddressPairStratum = {
	/**
	 * Either point holds 100 or more distinct street-and-number pairs from its source.
	 */
	StackedPoint: "stacked-point",
	/**
	 * The two rows share a locality, street and number but state different postcodes.
	 */
	PostcodeDiffers: "postcode-differs",
	/**
	 * One row states a unit and the other states none.
	 */
	UnitAgainstNone: "unit-against-none",
	/**
	 * Both rows state a unit, and the identifiers differ.
	 */
	UnitDiffers: "unit-differs",
	/**
	 * Both rows state a unit written differently whose identifiers agree, such as `#2` and `UNIT 2`.
	 */
	UnitSpelling: "unit-spelling",
	/**
	 * The units agree and the points lie farther apart than the deterministic rule's 0.002 degrees.
	 */
	Distant: "distant",
	/**
	 * The units agree and the points lie within 0.002 degrees.
	 */
	Coincident: "coincident",
} as const

export type AddressPairStratum = (typeof AddressPairStratum)[keyof typeof AddressPairStratum]

/**
 * One address point as the pair set records it.
 */
export interface AddressPairRecord {
	source: string
	rank: number
	sourceRecordID: string
	authority: string | null
	number: string
	unit: string | null
	unitIdentifier: string | null
	streetRaw: string
	postcode: string | null
	localities: string[]
	placement: string | null
	lat: number
	lon: number
	/**
	 * Distinct street-and-number pairs this record's source places at the same point, rounded to 1e-5 degrees.
	 */
	stack: number
}

/**
 * One sampled pair, with the evidence an adjudicator reads and the fields the adjudicator fills.
 */
export interface AddressPair {
	pairID: string
	region: string
	stratum: AddressPairStratum
	higher: AddressPairRecord
	lower: AddressPairRecord
	distanceMeters: number
	/**
	 * Whether the deterministic rule drops the lower row: same postcode key,
	 * same raw unit, points within 0.002°.
	 */
	ruleDrops: boolean
	adjudication: "same-address" | "different-address" | "unsure" | null
	adjudicator: string | null
	rationale: string | null
}

export interface AddressPairSampleOptions {
	/**
	 * The directory holding `addresses/<region>/<version>/`.
	 */
	root: PathBuilderLike
	version: string
	regions: readonly string[]
	/**
	 * The pairs kept per stratum across all regions.
	 *
	 * @defaultValue `60`
	 */
	perStratum?: number
	/**
	 * Selects which key groups are read.
	 * The same seed over the same layer samples the same pairs.
	 *
	 * @defaultValue `1`
	 */
	seed?: number
	/**
	 * Rows of each region's key table to read, at most, before the region's sample closes.
	 *
	 * @defaultValue `400_000`
	 */
	rowsPerRegion?: number
	/**
	 * Draws the unlabeled population EM is fitted on instead of the stratified set:
	 * every candidate pair of each sampled key group is kept, without strata caps,
	 * until a region has yielded this number of pairs.
	 */
	populationPerRegion?: number
	/**
	 * Pair ids left out of the sample, such as an earlier set's, so a held-out set shares no pair with it.
	 */
	exclude?: ReadonlySet<string>
	outJSONL?: string
}

export interface AddressPairSampleResult {
	pairs: AddressPair[]
	/**
	 * Pairs kept per stratum.
	 */
	strata: Record<AddressPairStratum, number>
	/**
	 * Candidate pairs seen per stratum before the caps applied.
	 */
	candidates: Record<AddressPairStratum, number>
}

/**
 * The stack size from which a pair lands in the stacked-point stratum.
 *
 * Every record's stack is recorded exactly, whatever its size, so the rule the layer
 * build applies to smaller stacks grades on the same values.
 */
const STACK_MIN_ADDRESSES = 100
const RULE_DEGREES = 0.002
const POSTCODE_NEAR_DEGREES = 0.005

interface KeyRow {
	scope: string
	street: string
	number: string
	address_id: number
	source_id: number
}

interface DetailRow {
	address_id: number
	source_id: number
	source_record_id: string
	number: string
	unit: string | null
	street_raw: string
	postcode: string | null
	names: string
	lat: number
	lon: number
	placement: string | null
	authority: string | null
}

function sourceRank(name: string): number {
	if (name === "usgov-nad") return 0

	return name.startsWith("openaddresses:") ? 1 : 2
}

const pointKey = (lat: number, lon: number) => `${lat.toFixed(5)},${lon.toFixed(5)}`

function strataRecord<T>(value: () => T): Record<AddressPairStratum, T> {
	return Object.fromEntries(Object.values(AddressPairStratum).map((stratum) => [stratum, value()])) as Record<
		AddressPairStratum,
		T
	>
}

/**
 * Samples cross-source pairs from each region and keeps up to `perStratum`
 * per stratum, taking regions in turn.
 */
export async function addressPairSample(
	options: AddressPairSampleOptions,
	log: (line: string) => void = () => {}
): Promise<AddressPairSampleResult> {
	const perStratum = options.perStratum ?? 60
	const seed = options.seed ?? 1
	const rowsPerRegion = options.rowsPerRegion ?? 400_000
	const population = options.populationPerRegion
	const regionCap = population ?? Math.ceil(perStratum / options.regions.length) + 2
	const byRegion: Array<Record<AddressPairStratum, AddressPair[]>> = []
	const candidates = strataRecord(() => 0)
	const seenPairs = new Set<string>()

	for (const region of options.regions) {
		const files = addressLayerFiles(options.root, region, options.version)

		using lookup = new DatabaseClient<unknown>(files.lookup, { readOnly: true })
		using detail = new DatabaseClient<unknown>(files.detail, { readOnly: true })

		const sources = new Map(
			(lookup.prepare("SELECT source_id, name FROM source").all() as Array<{ source_id: number; name: string }>).map(
				(row) => [row.source_id, row.name]
			)
		)

		const stacks = new Map<string, number>()

		for (const row of detail
			.prepare(
				`SELECT source_id, round(lat, 5) AS la, round(lon, 5) AS lo, count(DISTINCT street_raw || '|' || number) AS n
				 FROM address GROUP BY source_id, la, lo HAVING n > 1`
			)
			.all() as Array<{ source_id: number; la: number; lo: number; n: number }>) {
			stacks.set(`${row.source_id}@${pointKey(row.la, row.lo)}`, row.n)
		}

		const readDetail = detail.prepare(
			`SELECT address_id, source_id, source_record_id, number, unit, street_raw, postcode, names, lat, lon, placement,
				authority FROM address WHERE address_id = ?`
		)

		const record = (id: number): AddressPairRecord => {
			const row = readDetail.get(id) as DetailRow | undefined

			if (!row) throw new Error(`${files.detail} holds no address ${id}, which ${files.lookup} keys`)
			const source = sources.get(row.source_id) ?? `source:${row.source_id}`
			const names = parseJSONStrict<Array<{ level: string; value: string }>>(row.names)

			return {
				source,
				rank: sourceRank(source),
				sourceRecordID: row.source_record_id,
				authority: row.authority,
				number: row.number,
				unit: row.unit,
				unitIdentifier: usUnitIdentifier(row.unit, { number: row.number, street: row.street_raw }),
				streetRaw: row.street_raw,
				postcode: row.postcode,
				localities: names.filter((name) => name.level === "locality").map((name) => name.value),
				placement: row.placement,
				lat: row.lat,
				lon: row.lon,
				stack: stacks.get(`${row.source_id}@${pointKey(row.lat, row.lon)}`) ?? 1,
			}
		}

		const kept = strataRecord<AddressPair[]>(() => [])
		const regionTotal = () => Object.values(kept).reduce((sum, pairs) => sum + pairs.length, 0)
		const totalRows = (lookup.prepare("SELECT sum(records) AS n FROM source").get() as { n: number }).n
		const stride = Math.max(1, Math.round(totalRows / rowsPerRegion))

		const consider = (group: KeyRow[], fromLocality: boolean) => {
			const ranked = group.map((row) => ({ row, rank: sourceRank(sources.get(row.source_id) ?? "") }))

			for (const low of ranked) {
				for (const high of ranked) {
					if (high.rank >= low.rank) continue

					const higher = record(high.row.address_id)
					const lower = record(low.row.address_id)

					if (fromLocality && higher.postcode === lower.postcode) continue

					const degrees = Math.max(Math.abs(higher.lat - lower.lat), Math.abs(higher.lon - lower.lon))

					if (fromLocality && degrees > POSTCODE_NEAR_DEGREES) continue

					const pairID = `${region}:${higher.sourceRecordID}:${lower.sourceRecordID}`

					// A key group can hold one record twice under one source id.
					// The second copy would repeat the pair.
					if (options.exclude?.has(pairID) || seenPairs.has(pairID)) continue

					seenPairs.add(pairID)

					const stratum = addressPairStratum(higher, lower, degrees, fromLocality)

					candidates[stratum]++

					if (population ? regionTotal() >= population : kept[stratum].length >= regionCap) continue

					kept[stratum].push({
						pairID,
						region,
						stratum,
						higher,
						lower,
						distanceMeters: Math.round(haversine(higher.lat, higher.lon, lower.lat, lower.lon) * 1000 * 10) / 10,
						ruleDrops: !fromLocality && higher.unit === lower.unit && degrees <= RULE_DEGREES,
						adjudication: null,
						adjudicator: null,
						rationale: null,
					})
				}
			}
		}

		// A postcode key group fills every stratum but postcode-differs, and a locality key group
		// fills only that one, so each pass stops once the strata it can fill are at the region's cap.
		// A population draw instead stops once the region has yielded its quota.
		const filled = (fromLocality: boolean) =>
			population
				? regionTotal() >= population
				: Object.values(AddressPairStratum)
						.filter((stratum) => (stratum === AddressPairStratum.PostcodeDiffers) === fromLocality)
						.every((stratum) => stratum === AddressPairStratum.StackedPoint || kept[stratum].length >= regionCap)

		for (const [table, fromLocality] of [
			["key_postcode", false],
			["key_locality", true],
		] as const) {
			let group: KeyRow[] = []
			let read = 0

			for (const row of lookup
				.prepare(`SELECT scope, street, number, address_id, source_id FROM ${table}`)
				.iterate() as Iterable<KeyRow>) {
				if (++read > rowsPerRegion * stride || filled(fromLocality)) break

				const last = group[0]

				if (last && (last.scope !== row.scope || last.street !== row.street || last.number !== row.number)) {
					if (new Set(group.map((member) => member.source_id)).size > 1) {
						consider(group, fromLocality)
					}

					group = []
				}

				if (group.length || hashFNV1a(`${row.scope}|${row.street}|${row.number}`, seed) % stride === 0) {
					group.push(row)
				}
			}

			if (new Set(group.map((member) => member.source_id)).size > 1) {
				consider(group, fromLocality)
			}
		}

		byRegion.push(kept)

		log(
			`${region}: ${Object.entries(kept)
				.map(([stratum, pairs]) => `${stratum} ${pairs.length}`)
				.join(", ")}`
		)
	}

	const pairs: AddressPair[] = []
	const strata = strataRecord(() => 0)

	for (const stratum of population ? [] : Object.values(AddressPairStratum)) {
		for (let index = 0; strata[stratum] < perStratum; index++) {
			let added = false

			for (const kept of byRegion) {
				const pair = kept[stratum][index]

				if (pair && strata[stratum] < perStratum) {
					pairs.push(pair)

					strata[stratum]++
					added = true
				}
			}

			if (!added) break
		}
	}

	if (population) {
		for (const kept of byRegion) {
			for (const [stratum, list] of Object.entries(kept) as Array<[AddressPairStratum, AddressPair[]]>) {
				pairs.push(...list)
				strata[stratum] += list.length
			}
		}
	}

	if (options.outJSONL) {
		await writeLocalJSONLFile(pairs, options.outJSONL)
	}

	return { pairs, strata, candidates }
}

function addressPairStratum(
	higher: AddressPairRecord,
	lower: AddressPairRecord,
	degrees: number,
	fromLocality: boolean
): AddressPairStratum {
	if (higher.stack >= STACK_MIN_ADDRESSES || lower.stack >= STACK_MIN_ADDRESSES) return AddressPairStratum.StackedPoint

	if (fromLocality) return AddressPairStratum.PostcodeDiffers

	if ((higher.unitIdentifier == null) !== (lower.unitIdentifier == null)) return AddressPairStratum.UnitAgainstNone

	if (higher.unitIdentifier !== lower.unitIdentifier) return AddressPairStratum.UnitDiffers

	if (higher.unit !== lower.unit) return AddressPairStratum.UnitSpelling

	return degrees > RULE_DEGREES ? AddressPairStratum.Distant : AddressPairStratum.Coincident
}
