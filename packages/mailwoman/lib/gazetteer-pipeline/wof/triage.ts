/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { pathExists } from "@mailwoman/core/fs/readers"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { resolvePath, type PathBuilderLike } from "path-ts"

const TRIAGE_PLACETYPES = ["locality", "localadmin", "borough"] as const

const COVER_PLACETYPES = ["locality", "localadmin", "borough", "county", "macrocounty", "region"] as const

const COVERAGE_RADIUS_KM = 10

/**
 * Enumerates why a non-current, unsuperseded record is absent from the index:
 * deprecated without a successor, or marked not current with no stated reason.
 */
export const CurrencyClass = {
	DeprecatedNoSuccessor: "deprecated_no_successor",
	NotCurrentUnstated: "not_current_unstated",
} as const

/**
 * Names one {@link CurrencyClass} value.
 */
export type CurrencyClass = (typeof CurrencyClass)[keyof typeof CurrencyClass]

/**
 * Enumerates whether a live record within 10 km already serves a non-current place,
 * by exact name and placetype, exact name in another placetype, name containment, or not at all.
 */
export const CoverageVerdict = {
	CoveredExact: "covered_exact",
	CoveredCrossBand: "covered_cross_band",
	CoveredContainment: "covered_containment",
	Uncovered: "uncovered",
} as const

/**
 * Names one {@link CoverageVerdict} value.
 */
export type CoverageVerdict = (typeof CoverageVerdict)[keyof typeof CoverageVerdict]

/**
 * Records whether GeoNames has a populated place of the same name nearby,
 * which separates an upstream-pruned real place from a pruned ghost.
 *
 * `unmeasured` means no GeoNames dump was available for the country.
 */
export interface TriageAttestation {
	/**
	 * The attestation result, where `unmeasured` means no dump existed to check,
	 * unlike `unattested`, which means the check found nothing.
	 */
	state: "attested" | "unattested" | "unmeasured"
	population?: number
	distanceKm?: number
}

/**
 * The live record a coverage verdict rests on.
 */
export interface CoveredBy {
	id: number
	name: string
	placetype: string
	distanceKm: number
}

/**
 * Describes one non-current record with its currency class, coverage verdict and attestation.
 */
export interface TriageRow {
	id: number
	name: string
	placetype: string
	country: string
	latitude: number
	longitude: number

	/**
	 * The record's population, where 0 means the gazetteer carries none rather than a measured zero.
	 */
	population: number
	currencyClass: CurrencyClass
	coverage: CoverageVerdict

	/**
	 * The live record that covers this place, if any, so a reviewer can see
	 * which record and placetype made the call.
	 */
	coveredBy?: CoveredBy
	attestation: TriageAttestation
}

/**
 * Counts coverage verdicts for one country and currency class, with `uncoveredAttested`
 * present only when attestation was measured.
 */
export interface TriageSummary {
	country: string
	currencyClass: CurrencyClass
	total: number
	coveredExact: number
	coveredCrossBand: number
	coveredContainment: number
	uncovered: number

	/**
	 * The number of uncovered rows that GeoNames attests, which heads the review queue.
	 *
	 * It is `undefined` when the country has no dump, so 0 always means checked and none found.
	 */
	uncoveredAttested?: number
}

/**
 * Configures {@link triageWOFCurrency}, which reads GeoNames `<CC>.txt` dumps from
 * `geonamesDir` and triages every country when `countries` is omitted.
 */
export interface TriageOptions {
	/**
	 * The admin gazetteer database to triage, such as `admin-global-priority.db`.
	 */
	adminDB: PathBuilderLike

	/**
	 * The directory of per-country GeoNames dumps; a country without a `<CC>.txt`
	 * file is reported `unmeasured`.
	 */
	geonamesDir?: PathBuilderLike

	/**
	 * The ISO 3166-1 alpha-2 countries to triage, defaulting to every country in the database.
	 */
	countries?: readonly string[]

	/**
	 * Receives progress messages by phase.
	 */
	onProgress?: (phase: string, message: string) => void
}

/**
 * Holds the per-record ledger and per-country summaries produced by {@link triageWOFCurrency}.
 */
export interface TriageResult {
	rows: TriageRow[]
	summary: TriageSummary[]
}

interface LiveRecord {
	id: number
	name: string
	placetype: string
	key: string
	words: Set<string>
	lat: number
	lon: number
}

function fold(value: string): string {
	return value
		.normalize("NFKD")
		.replaceAll(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replaceAll(/\s+/g, " ")
		.trim()
}

function judgeCoverage(
	dead: { key: string; words: Set<string>; lat: number; lon: number; placetype: string },
	neighbours: readonly LiveRecord[]
): { verdict: CoverageVerdict; coveredBy?: CoveredBy } {
	let containment: { record: LiveRecord; distanceKm: number } | undefined
	let crossBand: { record: LiveRecord; distanceKm: number } | undefined

	for (const live of neighbours) {
		const distanceKm = haversineKm(dead.lat, dead.lon, live.lat, live.lon)

		if (distanceKm > COVERAGE_RADIUS_KM) continue

		if (live.key === dead.key) {
			if (live.placetype === dead.placetype) {
				return {
					verdict: CoverageVerdict.CoveredExact,
					coveredBy: { id: live.id, name: live.name, placetype: live.placetype, distanceKm },
				}
			}

			if (!crossBand || distanceKm < crossBand.distanceKm) {
				crossBand = { record: live, distanceKm }
			}

			continue
		}

		const contains =
			live.key.length > 0 &&
			(dead.key.includes(live.key) || [...live.words].every((word) => live.words.size > 0 && dead.words.has(word)))

		if (contains && (!containment || distanceKm < containment.distanceKm)) {
			containment = { record: live, distanceKm }
		}
	}

	if (crossBand) {
		return {
			verdict: CoverageVerdict.CoveredCrossBand,
			coveredBy: {
				id: crossBand.record.id,
				name: crossBand.record.name,
				placetype: crossBand.record.placetype,
				distanceKm: crossBand.distanceKm,
			},
		}
	}

	if (containment) {
		return {
			verdict: CoverageVerdict.CoveredContainment,
			coveredBy: {
				id: containment.record.id,
				name: containment.record.name,
				placetype: containment.record.placetype,
				distanceKm: containment.distanceKm,
			},
		}
	}

	return { verdict: CoverageVerdict.Uncovered }
}

async function loadAttestors(
	dumpPath: string,
	keys: ReadonlySet<string>
): Promise<Map<string, { lat: number; lon: number; pop: number }[]>> {
	const out = new Map<string, { lat: number; lon: number; pop: number }[]>()

	for await (const f of readUnquotedTSV(dumpPath)) {
		if (f[6] !== "P") continue

		const candidates = [fold(String(f[1] ?? "")), fold(String(f[2] ?? ""))].filter((key) => key && keys.has(key))

		if (!candidates.length) continue

		const row = { lat: Number(f[4]), lon: Number(f[5]), pop: Number(f[14]) || 0 }

		for (const key of new Set(candidates)) {
			const bag = out.get(key)

			if (bag) {
				bag.push(row)
			} else {
				out.set(key, [row])
			}
		}
	}

	return out
}

/**
 * Triages an admin gazetteer's non-current locality, localadmin and borough records
 * into a reviewable ledger without writing to the database.
 */
export async function triageWOFCurrency(opts: TriageOptions): Promise<TriageResult> {
	const progress = opts.onProgress ?? (() => {})
	using db = new DatabaseClient<WOFDatabase>(opts.adminDB, { readOnly: true })

	const placetypes = TRIAGE_PLACETYPES.map((pt) => `'${pt}'`).join(", ")

	const countries =
		opts.countries?.map((cc) => cc.toUpperCase()) ??
		db
			.prepare(
				`SELECT DISTINCT country FROM spr WHERE country IS NOT NULL AND country != '' AND placetype IN (${placetypes})`
			)
			.all()
			.map((r) => String(r["country"]))
			.toSorted()

	const coverPlacetypes = COVER_PLACETYPES.map((pt) => `'${pt}'`).join(", ")

	const liveStmt = db.prepare(
		`SELECT id, name, placetype, latitude, longitude FROM spr
		 WHERE country = ? AND placetype IN (${coverPlacetypes}) AND is_current != 0
		   AND latitude != 0 AND longitude != 0`
	)

	const deadStmt = db.prepare(
		`SELECT s.id AS id, s.name AS name, s.placetype AS placetype,
			s.latitude AS latitude, s.longitude AS longitude,
			s.is_deprecated AS is_deprecated, COALESCE(pp.population, 0) AS population
		 FROM spr s LEFT JOIN place_population pp ON pp.id = s.id
		 WHERE s.country = ? AND s.placetype IN (${placetypes})
		   AND s.is_current = 0 AND s.is_superseded = 0
		   AND s.latitude != 0 AND s.longitude != 0`
	)

	const rows: TriageRow[] = []
	const summary: TriageSummary[] = []

	for (const country of countries) {
		const dead = deadStmt.all(country)

		if (!dead.length) continue

		const live: LiveRecord[] = liveStmt
			.all(country)

			.filter((r) => String(r["name"] ?? "").trim().length)
			.map((r) => {
				const name = String(r["name"] ?? "")
				const key = fold(name)

				return {
					id: Number(r["id"]),
					name,
					placetype: String(r["placetype"] ?? ""),
					key,
					words: new Set(key.split(" ").filter((value) => value.length)),
					lat: Number(r["latitude"]),
					lon: Number(r["longitude"]),
				}
			})

		const keys = new Set(dead.map((r) => fold(String(r["name"] ?? ""))).filter((key) => key.length))
		const dumpPath = opts.geonamesDir ? resolvePath(opts.geonamesDir, `${country}.txt`) : undefined
		const attestors = dumpPath && (await pathExists(dumpPath)) ? await loadAttestors(dumpPath, keys) : undefined

		if (!attestors) {
			progress("triage", `${country}: no GeoNames dump — attestation reported unmeasured`)
		}

		const countryRows: TriageRow[] = []

		for (const record of dead) {
			const name = String(record["name"] ?? "")
			const key = fold(name)

			if (!key) continue

			const lat = Number(record["latitude"])
			const lon = Number(record["longitude"])
			const placetype = String(record["placetype"] ?? "")

			const { verdict, coveredBy } = judgeCoverage(
				{ key, words: new Set(key.split(" ").filter((value) => value.length)), lat, lon, placetype },
				live
			)

			let attestation: TriageAttestation = { state: "unmeasured" }

			if (attestors) {
				const near = (attestors.get(key) ?? [])
					.map((g) => ({ ...g, distanceKm: haversineKm(lat, lon, g.lat, g.lon) }))
					.filter((g) => g.distanceKm <= COVERAGE_RADIUS_KM)
					.toSorted((a, b) => b.pop - a.pop)

				attestation = near.length
					? { state: "attested", population: near[0]!.pop, distanceKm: near[0]!.distanceKm }
					: { state: "unattested" }
			}

			countryRows.push({
				id: Number(record["id"]),
				name,
				placetype,
				country,
				latitude: lat,
				longitude: lon,
				population: Number(record["population"]) || 0,
				currencyClass: Number(record["is_deprecated"])
					? CurrencyClass.DeprecatedNoSuccessor
					: CurrencyClass.NotCurrentUnstated,
				coverage: verdict,
				...(coveredBy ? { coveredBy } : {}),
				attestation,
			})
		}

		rows.push(...countryRows)

		for (const currencyClass of [CurrencyClass.DeprecatedNoSuccessor, CurrencyClass.NotCurrentUnstated]) {
			const classRows = countryRows.filter((r) => r.currencyClass === currencyClass)

			if (!classRows.length) continue

			const uncovered = classRows.filter((r) => r.coverage === CoverageVerdict.Uncovered)

			summary.push({
				country,
				currencyClass,
				total: classRows.length,
				coveredExact: classRows.filter((r) => r.coverage === CoverageVerdict.CoveredExact).length,
				coveredCrossBand: classRows.filter((r) => r.coverage === CoverageVerdict.CoveredCrossBand).length,
				coveredContainment: classRows.filter((r) => r.coverage === CoverageVerdict.CoveredContainment).length,
				uncovered: uncovered.length,
				...(attestors ? { uncoveredAttested: uncovered.filter((r) => r.attestation.state === "attested").length } : {}),
			})
		}

		progress("triage", `${country}: ${countryRows.length} non-current records judged`)
	}

	return { rows, summary }
}
