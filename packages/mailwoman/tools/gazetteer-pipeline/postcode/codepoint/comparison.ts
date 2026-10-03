/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `promotion-eval.ts` for the Code-Point Open GB database: compare it against the incumbent GeoNames
 * `GB_full` rows before anything swaps in `DEFAULT_POSTCODE_DATABASES`.
 *
 * The swap changes data sources rather than refreshing one source. The tool reports evidence for a decision.
 * A large coordinate delta points toward GeoNames because its GB provenance is unclear.
 *
 * The tool reports which postcodes appear in each source, keyed exactly on sanitized `spr.name`.
 * It reports the distance distribution for shared postcodes because a mean hides both modes in bimodal disagreement.
 * It also counts Northern Ireland explicitly because Code-Point Open omits it by product definition.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { percentile } from "@mailwoman/core/stats"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

/**
 * Meters per kilometer — {@link haversineKm} returns km and every figure here is reported in meters.
 */
const M_PER_KM = 1000

/**
 * A postcode present in one database and absent from the other, summarized by
 * postcode area rather than listed.
 *
 * The full list runs to six figures.
 * The area histogram is what tells you whether a gap is structural (a whole area missing)
 * or diffuse (churn spread across all of them).
 */
export interface AreaHistogram {
	total: number
	/**
	 * `{ area: count }`, descending by count when rendered.
	 */
	byArea: Record<string, number>
}

/**
 * The coordinate-disagreement distribution over postcodes present in both databases, in meters.
 */
export interface DeltaDistribution {
	joined: number
	p50: number
	p90: number
	p99: number
	max: number
	mean: number
	/**
	 * Share of joined postcodes further apart than 1 km — the tail worth reading rows from.
	 */
	over1km: number
	/**
	 * Share further apart than 10 km.
	 *
	 * At this distance the two sources are naming different places rather than rounding differently.
	 */
	over10km: number
}

/**
 * One hand-checked probe: a postcode whose true location is independently known.
 */
export interface ProbeResult {
	postcode: string
	landmark: string
	/**
	 * The independently-known coordinates the probe is judged against.
	 */
	expected: { latitude: number; longitude: number }
	codepoint: { latitude: number; longitude: number; metersFromExpected: number } | null
	incumbent: { latitude: number; longitude: number; metersFromExpected: number } | null
}

/**
 * The "only in the incumbent" set, split into the three things it actually contains.
 *
 * One number makes a swap look like a 92,704-postcode regression.
 * The split is what makes it a decision.
 */
export interface IncumbentOnlyBreakdown {
	total: number
	/**
	 * `BT` — Northern Ireland.
	 *
	 * A permanent, license-driven gap in Code-Point Open.
	 */
	northernIreland: number
	/**
	 * `IM`/`GY`/`JE` — Isle of Man, Guernsey, Jersey.
	 *
	 * Outside Great Britain, same license shape as NI.
	 */
	crownDependencies: number
	/**
	 * Everything else: postcodes the incumbent has and the current OS register does not.
	 *
	 * These are terminated postcodes.
	 * The incumbent snapshot never dropped them.
	 *
	 * Diffuse across every area (top: B, W, M, GU, SW…), which is the shape of churn
	 * rather than of a coverage hole.
	 *
	 * The currency-related drop is an improvement rather than a regression,
	 * though a consumer geocoding historical addresses would feel it.
	 */
	terminated: number
}

export interface CodePointCheckReport {
	codepointRows: number
	incumbentRows: number
	onlyInCodePoint: AreaHistogram
	onlyInIncumbent: AreaHistogram
	/**
	 * {@link onlyInIncumbent}, decomposed.
	 * See {@link IncumbentOnlyBreakdown}.
	 */
	incumbentOnlyBreakdown: IncumbentOnlyBreakdown
	delta: DeltaDistribution
	/**
	 * Northern Ireland, counted explicitly.
	 *
	 * See the module docstring.
	 */
	northernIreland: {
		incumbentBTRows: number
		codepointBTRows: number
	}
	/**
	 * Non-GB Crown-dependency areas covered by the incumbent and absent from
	 * Code-Point not (Isle of Man, Guernsey, Jersey).
	 *
	 * Same licensing shape as the NI rows and worth separating for the same reason.
	 */
	crownDependencies: {
		incumbentRows: Record<string, number>
		codepointRows: Record<string, number>
	}
	probes: ProbeResult[]
}

/**
 * Postcode areas covering Northern Ireland.
 *
 * Exactly one — `BT` is the whole province.
 */
const NORTHERN_IRELAND_AREAS = ["BT"] as const

/**
 * Crown-dependency postcode areas: Isle of Man, Guernsey, Jersey.
 *
 * These areas lie outside Great Britain and Code-Point Open.
 */
const CROWN_DEPENDENCY_AREAS = ["IM", "GY", "JE"] as const

/**
 * Hand-checked probes — postcodes whose real-world location is independently known,
 * so a coordinate can be judged right or wrong rather than merely different.
 *
 * Each probe can be verified individually.
 * Together they span England, Scotland and Wales.
 * They also cover both coordinate extremes in the join.
 *
 * A Code-Point centroid is the postcode unit's mean delivery point,
 * so tens of meters of offset is correct behavior.
 * The three city-center probes near 500-900 m use loose bounds because each landmark is a district.
 * Both databases agree there to within 3 m.
 *
 * `CF99 1SN` is not a typo: the Senedd's postcode changed from `CF99 1NA`
 * and the incumbent GeoNames snapshot still lists the retired one.
 * This is a small example of the terminated-postcode residual.
 */
export const CODEPOINT_PROBES = [
	{ postcode: "SW1A 1AA", landmark: "Buckingham Palace, London", latitude: 51.5014, longitude: -0.1419 },
	{ postcode: "SW1A 2AA", landmark: "10 Downing Street, London", latitude: 51.5034, longitude: -0.1276 },
	{ postcode: "SW1A 0AA", landmark: "Palace of Westminster (House of Commons)", latitude: 51.4995, longitude: -0.1248 },
	{ postcode: "EH99 1SP", landmark: "Scottish Parliament, Edinburgh", latitude: 55.9522, longitude: -3.1745 },
	{ postcode: "CF99 1SN", landmark: "Senedd, Cardiff Bay", latitude: 51.4638, longitude: -3.1625 },
	{ postcode: "B33 8TH", landmark: "Birmingham (the DVLA test postcode)", latitude: 52.4778, longitude: -1.8098 },
	{ postcode: "M1 1AE", landmark: "Manchester city centre", latitude: 53.4808, longitude: -2.2374 },
	{ postcode: "G1 1XW", landmark: "Glasgow city centre", latitude: 55.8608, longitude: -4.2493 },
	{ postcode: "EC1A 1BB", landmark: "London EC1, Smithfield", latitude: 51.5188, longitude: -0.1024 },
	{ postcode: "NE1 7RU", landmark: "Newcastle upon Tyne, Grey Street", latitude: 54.9722, longitude: -1.6139 },
] as const

/**
 * Every non-letter/number stripped — the sanitized form both databases store
 * as `spr.name`, so it is the join key.
 *
 * Duplicated from `resolver-wof-sqlite/geonames-postal.ts` rather than imported
 * because that package is an optional peer.
 */
function normalizeName(raw: string): string {
	return raw.replaceAll(/[^\p{L}\p{N}]/gu, "").toUpperCase()
}

/**
 * The postcode area — leading letters of the outward code.
 */
function areaOf(name: string): string {
	return /^[A-Z]{1,2}/.exec(name)?.[0] ?? ""
}

export interface RunCodePointCheckOptions {
	/**
	 * The candidate database, e.g. `<data-root>/db/wof/postalcode-gb-codepoint-<date>.db`.
	 */
	codepointPath: PathBuilderLike
	/**
	 * The incumbent, e.g. the frozen `<data-root>/db/wof/frozen-backup-2026-08-04/postalcode-geonames-tail.db`.
	 *
	 * Opened read-only — this tool never writes to either input.
	 */
	incumbentPath: PathBuilderLike
	onPhase?: (phase: string, detail?: string) => void
}

/**
 * Run the check.
 *
 * Both databases are opened read-only.
 * No write occurs anywhere.
 *
 * Memory: the incumbent's GB rows are held in a `Map` of ~1.84 M entries (~250 MB) so the join
 * is a single pass over each side rather than a SQL `attach` join across two 800 MB+ files.
 * Measured at ~40 s end to end.
 */
export function runCodePointCheck(options: RunCodePointCheckOptions): CodePointCheckReport {
	const phase = options.onPhase ?? (() => {})

	const codepoint = new DatabaseClient<WOFDatabase>(options.codepointPath, { readOnly: true })
	const incumbent = new DatabaseClient<WOFDatabase>(options.incumbentPath, { readOnly: true })

	try {
		phase("load", "incumbent GB rows")

		const incumbentByName = new Map<string, { latitude: number; longitude: number }>()

		for (const row of incumbent
			.prepare("SELECT name, latitude, longitude FROM spr WHERE country = 'GB' AND placetype = 'postalcode'")
			.iterate() as Iterable<{ name: string; latitude: number; longitude: number }>) {
			incumbentByName.set(normalizeName(row.name), { latitude: row.latitude, longitude: row.longitude })
		}

		phase("load", `${incumbentByName.size.toLocaleString()} incumbent postcodes`)

		const deltas: number[] = []
		const onlyInCodePointByArea: Record<string, number> = {}
		const seen = new Set<string>()
		let codepointRows = 0
		let over1km = 0
		let over10km = 0
		let deltaSum = 0

		phase("join", "candidate vs incumbent")

		for (const row of codepoint
			.prepare("SELECT name, latitude, longitude FROM spr WHERE placetype = 'postalcode'")
			.iterate() as Iterable<{ name: string; latitude: number; longitude: number }>) {
			const name = normalizeName(row.name)

			codepointRows++
			seen.add(name)

			const match = incumbentByName.get(name)

			if (!match) {
				const area = areaOf(name)

				onlyInCodePointByArea[area] = (onlyInCodePointByArea[area] ?? 0) + 1

				continue
			}

			const meters = haversineKm(row.latitude, row.longitude, match.latitude, match.longitude) * M_PER_KM

			deltas.push(meters)
			deltaSum += meters

			if (meters > M_PER_KM) {
				over1km++
			}

			if (meters > 10 * M_PER_KM) {
				over10km++
			}
		}

		phase("diff", "postcodes only in the incumbent")

		const onlyInIncumbentByArea: Record<string, number> = {}
		let onlyInIncumbentTotal = 0
		let orphanNI = 0
		let orphanCrown = 0

		for (const name of incumbentByName.keys()) {
			if (seen.has(name)) continue

			const area = areaOf(name)

			onlyInIncumbentByArea[area] = (onlyInIncumbentByArea[area] ?? 0) + 1

			onlyInIncumbentTotal++

			if ((NORTHERN_IRELAND_AREAS as readonly string[]).includes(area)) {
				orphanNI++
			} else if ((CROWN_DEPENDENCY_AREAS as readonly string[]).includes(area)) {
				orphanCrown++
			}
		}

		phase("stats", `${deltas.length.toLocaleString()} joined postcodes`)

		// Sort once here.
		// `percentile` copies and sorts internally.
		// It would repeat that work for 1.7 M values read four times, so these quantiles use this sorted array.
		deltas.sort((a, b) => a - b)

		const quantile = (p: number): number => percentile(deltas, p) ?? 0

		const delta: DeltaDistribution = {
			joined: deltas.length,
			p50: quantile(50),
			p90: quantile(90),
			p99: quantile(99),
			max: deltas.at(-1) ?? 0,
			mean: deltas.length ? deltaSum / deltas.length : 0,
			over1km,
			over10km,
		}

		const areaCount = (db: DatabaseClient<WOFDatabase>, areas: readonly string[]): Record<string, number> => {
			const counts: Record<string, number> = {}

			for (const area of areas) {
				const { c } = db
					.prepare("SELECT COUNT(*) c FROM spr WHERE placetype = 'postalcode' AND name GLOB ?")
					.get(`${area}[0-9]*`) as { c: number }

				counts[area] = c
			}

			return counts
		}

		phase("coverage", "Northern Ireland + Crown dependencies")
		const incumbentNI = areaCount(incumbent, NORTHERN_IRELAND_AREAS)
		const codepointNI = areaCount(codepoint, NORTHERN_IRELAND_AREAS)

		phase("probes", `${CODEPOINT_PROBES.length} hand-checked postcodes`)

		const probes = CODEPOINT_PROBES.map((probe): ProbeResult => {
			const key = normalizeName(probe.postcode)
			const expected = { latitude: probe.latitude, longitude: probe.longitude }

			const cp = codepoint
				.prepare("SELECT latitude, longitude FROM spr WHERE placetype = 'postalcode' AND name = ?")
				.get(key) as { latitude: number; longitude: number } | undefined

			const inc = incumbentByName.get(key)

			return {
				postcode: probe.postcode,
				landmark: probe.landmark,
				expected,
				codepoint: cp
					? {
							...cp,
							metersFromExpected:
								haversineKm(cp.latitude, cp.longitude, expected.latitude, expected.longitude) * M_PER_KM,
						}
					: null,
				incumbent: inc
					? {
							...inc,
							metersFromExpected:
								haversineKm(inc.latitude, inc.longitude, expected.latitude, expected.longitude) * M_PER_KM,
						}
					: null,
			}
		})

		return {
			codepointRows,
			incumbentRows: incumbentByName.size,
			onlyInCodePoint: {
				total: Object.values(onlyInCodePointByArea).reduce((s, n) => s + n, 0),
				byArea: onlyInCodePointByArea,
			},
			onlyInIncumbent: { total: onlyInIncumbentTotal, byArea: onlyInIncumbentByArea },
			incumbentOnlyBreakdown: {
				total: onlyInIncumbentTotal,
				northernIreland: orphanNI,
				crownDependencies: orphanCrown,
				terminated: onlyInIncumbentTotal - orphanNI - orphanCrown,
			},
			delta,
			northernIreland: {
				incumbentBTRows: incumbentNI.BT ?? 0,
				codepointBTRows: codepointNI.BT ?? 0,
			},
			crownDependencies: {
				incumbentRows: areaCount(incumbent, CROWN_DEPENDENCY_AREAS),
				codepointRows: areaCount(codepoint, CROWN_DEPENDENCY_AREAS),
			},
			probes,
		}
	} finally {
		codepoint.destroy()
		incumbent.destroy()
	}
}

/**
 * Render the report as plain lines.
 *
 * Kept separate from {@link runCodePointCheck} so the numbers can be consumed
 * programmatically without parsing prose.
 */
export function formatCodePointCheckReport(report: CodePointCheckReport): string[] {
	const topAreas = (histogram: AreaHistogram, n = 8): string =>
		Object.entries(histogram.byArea)
			.toSorted((a, b) => b[1] - a[1])
			.slice(0, n)
			.map(([area, count]) => `${area} ${count.toLocaleString()}`)
			.join(" · ")

	const lines = [
		`rows: codepoint ${report.codepointRows.toLocaleString()} vs incumbent ${report.incumbentRows.toLocaleString()} (${
			report.codepointRows - report.incumbentRows > 0 ? "+" : ""
		}${(report.codepointRows - report.incumbentRows).toLocaleString()})`,
		`only in codepoint: ${report.onlyInCodePoint.total.toLocaleString()} — ${topAreas(report.onlyInCodePoint)}`,
		`only in incumbent: ${report.onlyInIncumbent.total.toLocaleString()} — ${topAreas(report.onlyInIncumbent)}`,
		`  = Northern Ireland ${report.incumbentOnlyBreakdown.northernIreland.toLocaleString()} + Crown dependencies ${report.incumbentOnlyBreakdown.crownDependencies.toLocaleString()} + terminated postcodes ${report.incumbentOnlyBreakdown.terminated.toLocaleString()}`,
		`coordinate delta over ${report.delta.joined.toLocaleString()} joined postcodes (meters):`,
		`  p50 ${report.delta.p50.toFixed(1)} · p90 ${report.delta.p90.toFixed(1)} · p99 ${report.delta.p99.toFixed(1)} · max ${report.delta.max.toFixed(1)} · mean ${report.delta.mean.toFixed(1)}`,
		`  over 1 km: ${report.delta.over1km.toLocaleString()} · over 10 km: ${report.delta.over10km.toLocaleString()}`,
		`Northern Ireland: incumbent ${report.northernIreland.incumbentBTRows.toLocaleString()} BT rows · codepoint ${report.northernIreland.codepointBTRows.toLocaleString()}`,
		`Crown dependencies: incumbent ${stringifyJSON(report.crownDependencies.incumbentRows)} · codepoint ${stringifyJSON(report.crownDependencies.codepointRows)}`,
		"probes (meters from the independently-known landmark position):",
	]

	for (const probe of report.probes) {
		const cp = probe.codepoint ? `${probe.codepoint.metersFromExpected.toFixed(0)} m` : "ABSENT"
		const inc = probe.incumbent ? `${probe.incumbent.metersFromExpected.toFixed(0)} m` : "ABSENT"

		lines.push(
			`  ${probe.postcode.padEnd(9)} codepoint ${cp.padStart(8)} · incumbent ${inc.padStart(8)} — ${probe.landmark}`
		)
	}

	return lines
}
