/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   WOF currency triage — a REPORT over the admin gazetteer's non-current records, so a coverage hole
 *   that upstream created is reviewable instead of invisible.
 *
 *   The motivating case (2026-08-19): `Rochester, Kent` — a ~28k cathedral city — resolved 474 km away
 *   to a Northumberland hamlet, because WOF deprecated the record in a January 2019 batch
 *   (`edtf:deprecated: 2019-01-16` on 53 of the 66 readable GB deprecated-no-successor localities)
 *   without writing successors. The Medway cluster shows the shape: `Chatham` stayed current,
 *   `Rochester` and `Gillingham` were deprecated, and the replacement `Medway` localadmin is itself
 *   NOT current. Every record looks individually plausible; only the cluster is wrong.
 *
 *   THIS MODULE DECIDES NOTHING. It measures and reports, because the non-current population is a
 *   MIXTURE that no rule separates — measured over the shipped artifact:
 *
 *   - genuine ghost towns (`Treece`, Kansas — evacuated),
 *   - abolished administrative districts (`Shepway District` → Folkestone & Hythe, 2018),
 *   - legal-form duplicates of live places (`Town of Gilbert`, `Commonwealth of Pennsylvania`,
 *     `Arrondissement de Lyon` — the place is alive under the name people type),
 *   - and live places wrongly marked (`Carter Lake` IA, `Dwarka` Delhi, `Briey` FR, `South
 *     Lanarkshire`).
 *
 *   A blanket "fall back to non-current records" would inject the third class into every ranking race —
 *   the wrong-instance hazard wearing a coverage costume. So the ledger's job is to hand a reviewer the
 *   evidence per row: which class, whether a live record already covers the place, and whether a second
 *   source attests it.
 *
 *   Absence is reported as absence throughout: a country with no GeoNames dump reads `unmeasured`,
 *   never `unattested`.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { haversineKm } from "@mailwoman/spatial"
import { TSVSpliterator } from "spliterator"

/**
 * Admin placetypes the triage covers — the bands an address's locality span resolves against. Regions and countries are
 * excluded: their non-current records are historical polities, a different question with different evidence.
 */
const TRIAGE_PLACETYPES = ["locality", "localadmin", "borough"] as const

/**
 * Placetypes searched for a LIVE cover — wider than the subject bands on purpose. WOF's January 2019 GB batch demoted
 * cities out of the locality band while leaving a same-named county/region standing: `Swansea` (pop 300,352) is
 * reachable only as a principal area 6.1 km from the city, and bare `Newport` now races six live namesake localities
 * with the 161k Welsh city absent from the band. A cover in another band is a different fact from no cover at all, and
 * the ledger has to say which.
 */
const COVER_PLACETYPES = ["locality", "localadmin", "borough", "county", "macrocounty", "region"] as const

/**
 * Radius for "is this place already covered by a live record", km. Matches the currency backfill's gate radius, and for
 * the same reason: a locality centroid and its live twin can sit kilometres apart, while a same-named place in another
 * region is a different place entirely.
 */
const COVERAGE_RADIUS_KM = 10

/**
 * Why a record is not in the index.
 *
 * - `deprecated_no_successor` — `is_deprecated` with `is_superseded = 0`. The upstream-mistake shape: a deprecation that
 *   names no replacement. 4,137 admin records globally on the 2026-08-19 artifact.
 * - `not_current_unstated` — `is_current = 0` with neither deprecation nor supersession. Ten times larger (43,755) and
 *   dominated by legal-form duplicates, which is why it is a separate class rather than more of the same.
 */
export const CurrencyClass = {
	DeprecatedNoSuccessor: "deprecated_no_successor",
	NotCurrentUnstated: "not_current_unstated",
} as const

export type CurrencyClass = (typeof CurrencyClass)[keyof typeof CurrencyClass]

/**
 * Whether a LIVE record already serves this place, and by what evidence.
 *
 * - `covered_exact` — a live record of the same folded name within {@link COVERAGE_RADIUS_KM}.
 * - `covered_containment` — a live neighbour whose name this one CONTAINS: `Town of Gilbert` over live `Gilbert`,
 *   `Arrondissement de Lyon` over live `Lyon`. This verdict is what keeps the legal-form class out of the hole count —
 *   a same-NAME-STRING test alone called 21,010 US rows holes, and the samples were `Commonwealth of Pennsylvania` and
 *   `Town of Cary`. Directional: `Telford` inside live `Telford and Wrekin` is NOT a cover, because no query for
 *   Telford resolves through it.
 * - `covered_cross_band` — a live record of the same name nearby, but at a DIFFERENT placetype: the place answers at
 *   coarser granularity and loses its in-band race. `Swansea` and `Newport` are the measured cases.
 * - `uncovered` — no live record nearby bears or contains the name. The class a reviewer must judge (`Telford`).
 */
export const CoverageVerdict = {
	CoveredExact: "covered_exact",
	CoveredCrossBand: "covered_cross_band",
	CoveredContainment: "covered_containment",
	Uncovered: "uncovered",
} as const

export type CoverageVerdict = (typeof CoverageVerdict)[keyof typeof CoverageVerdict]

/**
 * A second source's attestation of the same name near the same point — the evidence that separates "upstream pruned a
 * real place" from "upstream pruned a ghost".
 */
export interface TriageAttestation {
	/**
	 * `unmeasured` when no dump exists for the country: the pass could not look, which is NOT the same as looking and
	 * finding nothing (the meaning-of-zero rule).
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

export interface TriageRow {
	id: number
	name: string
	placetype: string
	country: string
	latitude: number
	longitude: number
	/**
	 * The record's own population, or 0 when the artifact carries none. Zero here is WOF's absence, not a measured zero.
	 */
	population: number
	currencyClass: CurrencyClass
	coverage: CoverageVerdict
	/**
	 * The live record that covers this place, when one does — so a reviewer can see WHICH record made the call, and at
	 * what band.
	 */
	coveredBy?: CoveredBy
	attestation: TriageAttestation
}

export interface TriageSummary {
	country: string
	currencyClass: CurrencyClass
	total: number
	coveredExact: number
	coveredCrossBand: number
	coveredContainment: number
	uncovered: number
	/**
	 * Uncovered rows a second source attests — the review queue's head. `undefined` when the country has no dump, so a
	 * zero here always means "looked and found none".
	 */
	uncoveredAttested?: number
}

export interface TriageOptions {
	/**
	 * The admin gazetteer to triage (`admin-global-priority.db`).
	 */
	adminDB: string
	/**
	 * Per-country GeoNames dump directory. Countries without a `<CC>.txt` are reported `unmeasured`.
	 */
	geonamesDir?: string
	/**
	 * Restrict to these ISO-3166 alpha-2 countries. Omit for every country the artifact holds.
	 */
	countries?: readonly string[]
	/**
	 * Progress callback for CLI introspection.
	 */
	onProgress?: (phase: string, message: string) => void
}

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

/**
 * The shared fold for this pass: diacritic-stripped, lower-cased, whitespace-collapsed. Deliberately NOT
 * `normalizeLocalityForKey` — that is the RESOLVER's key discipline, and importing it here would tie a reporting pass
 * to a runtime contract it must be free to outlive.
 */
function fold(value: string): string {
	return value
		.normalize("NFKD")
		.replaceAll(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replaceAll(/\s+/g, " ")
		.trim()
}

/**
 * Does a live neighbour cover this place? Exact name first, then containment in either direction — see
 * {@link CoverageVerdict} for why containment is the required half.
 */
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
			// Same band is a true cover; another band answers the query at a coarser grain and is reported as
			// such — but only after the whole neighbourhood is searched, since an in-band cover may follow.
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

		// DIRECTIONAL, and the direction is the whole point: the dead name must CONTAIN a live one, because
		// then the place is reachable by the shorter name people type (`Town of Gilbert` over live `Gilbert`).
		// The reverse is not a cover — `Telford` sits inside live `Telford and Wrekin`, and nothing answers a
		// query for Telford. An empty live key would `includes()`-match everything, so it never participates.
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

/**
 * Folded name → P-class GeoNames rows for one country, restricted to the names actually being judged (the dump is
 * streamed; only the keys under review are held).
 */
async function loadAttestors(
	dumpPath: string,
	keys: ReadonlySet<string>
): Promise<Map<string, { lat: number; lon: number; pop: number }[]>> {
	const out = new Map<string, { lat: number; lon: number; pop: number }[]>()

	for await (const f of TSVSpliterator.fromAsync(dumpPath, { header: false })) {
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
 * Triage one admin gazetteer's non-current records into a reviewable ledger. Read-only: opens the artifact `readOnly`
 * and writes nothing.
 */
export async function triageWOFCurrency(opts: TriageOptions): Promise<TriageResult> {
	const progress = opts.onProgress ?? (() => {})
	const db = new DatabaseSync(opts.adminDB, { readOnly: true })

	try {
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
				// A nameless record cannot cover anything, and its empty key would substring-match every name.
				.filter((r) => String(r["name"] ?? "").trim().length > 0)
				.map((r) => {
					const name = String(r["name"] ?? "")
					const key = fold(name)

					return {
						id: Number(r["id"]),
						name,
						placetype: String(r["placetype"] ?? ""),
						key,
						words: new Set(key.split(" ").filter((value) => value.length > 0)),
						lat: Number(r["latitude"]),
						lon: Number(r["longitude"]),
					}
				})

			// Attestation is looked up only for names under review, and only where a dump exists.
			const keys = new Set(dead.map((r) => fold(String(r["name"] ?? ""))).filter((key) => key.length > 0))
			const dumpPath = opts.geonamesDir ? resolve(opts.geonamesDir, `${country}.txt`) : undefined
			const attestors = dumpPath && existsSync(dumpPath) ? await loadAttestors(dumpPath, keys) : undefined

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
					{ key, words: new Set(key.split(" ").filter((value) => value.length > 0)), lat, lon, placetype },
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
				const slice = countryRows.filter((r) => r.currencyClass === currencyClass)

				if (!slice.length) continue

				const uncovered = slice.filter((r) => r.coverage === CoverageVerdict.Uncovered)

				summary.push({
					country,
					currencyClass,
					total: slice.length,
					coveredExact: slice.filter((r) => r.coverage === CoverageVerdict.CoveredExact).length,
					coveredCrossBand: slice.filter((r) => r.coverage === CoverageVerdict.CoveredCrossBand).length,
					coveredContainment: slice.filter((r) => r.coverage === CoverageVerdict.CoveredContainment).length,
					uncovered: uncovered.length,
					...(attestors
						? { uncoveredAttested: uncovered.filter((r) => r.attestation.state === "attested").length }
						: {}),
				})
			}

			progress("triage", `${country}: ${countryRows.length} non-current records judged`)
		}

		return { rows, summary }
	} finally {
		db.close()
	}
}
