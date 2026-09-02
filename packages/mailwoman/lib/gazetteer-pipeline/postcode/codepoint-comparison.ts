/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `promotion-eval.ts` for the Code-Point Open GB database: compare it against the incumbent GeoNames
 *   `GB_full` rows before anything swaps in `DEFAULT_POSTCODE_DATABASES`.
 *
 *   This exists because the swap is a DATA-SOURCE change, not a refresh. The two sources disagree on
 *   which postcodes exist and on where each one is, and both kinds of disagreement have to be looked at
 *   before the shipped database moves. What this tool does NOT do is decide: a large coordinate delta is a
 *   FINDING, and the finding usually indicts GeoNames (whose GB provenance is the muddled one — see
 *   `geonames-tail.ts`'s `GB_LICENSE_NOTE`), not Code-Point Open, which is the authoritative upstream
 *   both datasets ultimately derive from.
 *
 *   Three questions, three sections of {@link CodePointGateReport}:
 *
 *   1. **Which postcodes are in one and not the other.** The join key is `spr.name`, which both databases
 *      store in the #920 sanitized form (`SW1A1AA`), so the comparison is exact rather than fuzzy.
 *   2. **How far apart the shared ones are.** Haversine metres per joined postcode, reported as a
 *      distribution rather than a mean — the mean of a bimodal disagreement is a number that describes
 *      neither mode.
 *   3. **Northern Ireland.** Code-Point Open has no `BT` rows by product definition. The incumbent does.
 *      That difference is the single largest coverage consequence of the swap and it gets counted
 *      explicitly rather than left inside the general "only in incumbent" bucket.
 */

import { percentile } from "@mailwoman/core/stats"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"

/**
 * Metres per kilometre — {@link haversineKm} returns km and every figure here is reported in metres.
 */
const M_PER_KM = 1000

/**
 * A postcode present in one database and absent from the other, summarized by postcode AREA rather than listed. The
 * full list runs to six figures; the area histogram is what tells you whether a gap is structural (a whole area
 * missing) or diffuse (churn spread across all of them).
 */
export interface AreaHistogram {
	total: number
	/**
	 * `{ AREA: count }`, descending by count when rendered.
	 */
	byArea: Record<string, number>
}

/**
 * The coordinate-disagreement distribution over postcodes present in BOTH databases, in metres.
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
	 * Share further apart than 10 km. At this distance the two sources are naming different places, not rounding
	 * differently.
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
 * The "only in the incumbent" set, split into the three things it actually contains. Reporting it as one number is what
 * makes a swap look like a 92,704-postcode regression; the split is what makes it a decision.
 */
export interface IncumbentOnlyBreakdown {
	total: number
	/**
	 * `BT` — Northern Ireland. A permanent, licence-driven gap in Code-Point Open.
	 */
	northernIreland: number
	/**
	 * `IM`/`GY`/`JE` — Isle of Man, Guernsey, Jersey. Outside Great Britain, same licence shape as NI.
	 */
	crownDependencies: number
	/**
	 * Everything else: postcodes the incumbent has and the current OS register does not. These are TERMINATED postcodes —
	 * the incumbent snapshot never dropped them. Diffuse across every area (top: B, W, M, GU, SW…), which is the shape of
	 * churn rather than of a coverage hole. Losing them is a currency IMPROVEMENT, not a regression, though a consumer
	 * geocoding historical addresses would feel it.
	 */
	terminated: number
}

export interface CodePointGateReport {
	codepointRows: number
	incumbentRows: number
	onlyInCodePoint: AreaHistogram
	onlyInIncumbent: AreaHistogram
	/**
	 * {@link onlyInIncumbent}, decomposed. See {@link IncumbentOnlyBreakdown}.
	 */
	incumbentOnlyBreakdown: IncumbentOnlyBreakdown
	delta: DeltaDistribution
	/**
	 * Northern Ireland, counted explicitly. See the module docstring.
	 */
	northernIreland: {
		incumbentBTRows: number
		codepointBTRows: number
	}
	/**
	 * Non-GB Crown-dependency areas the incumbent carries and Code-Point does not (Isle of Man, Guernsey, Jersey). Same
	 * licensing shape as the NI rows and worth separating for the same reason.
	 */
	crownDependencies: {
		incumbentRows: Record<string, number>
		codepointRows: Record<string, number>
	}
	probes: ProbeResult[]
}

/**
 * Postcode areas covering Northern Ireland. Exactly one — `BT` is the whole province.
 */
const NORTHERN_IRELAND_AREAS = ["BT"] as const

/**
 * Crown-dependency postcode areas: Isle of Man, Guernsey, Jersey. Outside Great Britain, and outside Code-Point Open.
 */
const CROWN_DEPENDENCY_AREAS = ["IM", "GY", "JE"] as const

/**
 * Hand-checked probes — postcodes whose real-world location is independently known, so a coordinate can be judged as
 * right or wrong rather than merely as different.
 *
 * Chosen for (a) being individually verifiable by a reader, and (b) spanning England, Scotland and Wales plus both
 * coordinate extremes of the join. `expected` is the landmark's own position; a Code-Point centroid is the postcode
 * unit's mean delivery point, so tens of metres of offset is correct behaviour and not error. The looser entries (the
 * three city-centre probes near 500-900 m) are loose because the LANDMARK coordinate is a district rather than a door —
 * both databases agree with each other there to within 3 m, which is the comparison this list is actually making.
 *
 * The Senedd probe is `CF99 1SN` and that is not a typo. It was originally `CF99 1NA`, which the first eval run
 * reported ABSENT from Code-Point Open and present in the incumbent. Chasing it found the real story rather than a bug:
 * the Senedd's postcode changed from `CF99 1NA` to `CF99 1SN` in 2021, Code-Point Open 2026-05 carries only the current
 * one, and the incumbent GeoNames snapshot still carries the retired one 114 m away. That single row is the whole
 * 33,761-postcode "only in incumbent" residual in miniature — those are TERMINATED postcodes, not missing coverage.
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
 * The #920 sanitized form — every non-letter/number stripped. Both databases store this as `spr.name`, so it is the
 * join key. Duplicated from `resolver-wof-sqlite/geonames-postal.ts` rather than imported because that package is an
 * OPTIONAL peer and this check must run without it.
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

export interface RunCodePointGateOptions {
	/**
	 * The candidate database, e.g. `<data-root>/wof/postalcode-gb-codepoint-<date>.db`.
	 */
	codepointPath: string
	/**
	 * The incumbent, e.g. the frozen `<data-root>/wof/frozen-backup-2026-08-04/postalcode-geonames-tail.db`. Opened
	 * READ-ONLY — this tool never writes to either input.
	 */
	incumbentPath: string
	onPhase?: (phase: string, detail?: string) => void
}

/**
 * Run the check. Both databases are opened read-only; nothing is written anywhere.
 *
 * Memory: the incumbent's GB rows are held in a `Map` of ~1.84 M entries (~250 MB) so the join is a single pass over
 * each side rather than a SQL `ATTACH` join across two 800 MB+ files. Measured at ~40 s end to end.
 */
export function runCodePointGate(options: RunCodePointGateOptions): CodePointGateReport {
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

		// Sorted ONCE here. `percentile` copies-and-sorts internally, which is the right default for a
		// small sample and the wrong one for 1.7 M values read four times — so the quantiles are taken off
		// this array directly. `percentile` is still used for the shape of the index arithmetic.
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
 * Render the report as plain lines. Kept separate from {@link runCodePointGate} so the numbers can be consumed
 * programmatically without parsing prose.
 */
export function formatCodePointGateReport(report: CodePointGateReport): string[] {
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
		`coordinate delta over ${report.delta.joined.toLocaleString()} joined postcodes (metres):`,
		`  p50 ${report.delta.p50.toFixed(1)} · p90 ${report.delta.p90.toFixed(1)} · p99 ${report.delta.p99.toFixed(1)} · max ${report.delta.max.toFixed(1)} · mean ${report.delta.mean.toFixed(1)}`,
		`  over 1 km: ${report.delta.over1km.toLocaleString()} · over 10 km: ${report.delta.over10km.toLocaleString()}`,
		`Northern Ireland: incumbent ${report.northernIreland.incumbentBTRows.toLocaleString()} BT rows · codepoint ${report.northernIreland.codepointBTRows.toLocaleString()}`,
		`Crown dependencies: incumbent ${JSON.stringify(report.crownDependencies.incumbentRows)} · codepoint ${JSON.stringify(report.crownDependencies.codepointRows)}`,
		"probes (metres from the independently-known landmark position):",
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
