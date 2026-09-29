/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Restores deprecated WOF localities only when an independent source attests them.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { isStrictlyFiner } from "@mailwoman/core/resources/whosonfirst"
import { haversineKm } from "@mailwoman/spatial"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { type PathBuilderLike, resolvePath } from "path-ts"
import { TSVSpliterator } from "spliterator"

import type { loadImportanceIndex } from "#candidate/importance"
import type { PlaceAttrs, StageRow } from "#candidate/place-attrs"
import type { CandidateDatabase } from "#candidate/schema"
import type { WOFDatabase } from "#schema"
import { normalizeLocalityForKey } from "#street/normalize"

const CURRENCY_BACKFILL_RADIUS_KM = 10

const CURRENCY_BACKFILL_POP_FLOOR = 1000

/**
 * Restore a deprecated locality only when no nearby live namesake exists and GeoNames
 * attests the same folded name above {@link CURRENCY_BACKFILL_POP_FLOOR}.
 */
export interface CurrencyBackfillOutcomes {
	judged: number
	blocked: number
	unattested: number
	floored: number
	resurrected: number
}

/**
 * One country's read of the check — every dead name judged, by outcome and by the dead
 * row's placetype — so a census can say what a wider query admits.
 */
export interface CurrencyBackfillCountryReport extends CurrencyBackfillOutcomes {
	country: string
	deadPlacetypes: readonly string[]
	dumpPresent: boolean
	byDeadPlacetype: Record<string, CurrencyBackfillOutcomes>
	/**
	 * The first resurrected names, `placetype:name`, capped because the report is a receipt and not the table.
	 */
	sample: string[]
}

const REPORT_SAMPLE_SIZE = 25

/**
 * The placetypes a dead row may have to be judged at all; `locality` is the shipped default.
 */
export const DEFAULT_DEAD_PLACETYPES: readonly string[] = ["locality"]

function emptyOutcomes(): CurrencyBackfillOutcomes {
	return { judged: 0, blocked: 0, unattested: 0, floored: 0, resurrected: 0 }
}

export async function resurrectCurrencyHoles(ctx: {
	src: DatabaseClient<WOFDatabase>
	/**
	 * The candidate build's transaction, required unless `dryRun`.
	 */
	tx?: DatabaseClient<CandidateDatabase>
	geonamesDir: PathBuilderLike
	countries: readonly string[]
	attrs: Map<number, PlaceAttrs>
	ccID: (code: string | null) => number
	ptID: (pt: string | null) => number
	regionOf: Map<number, number>
	importance: ReturnType<typeof loadImportanceIndex> | undefined
	stageRow: StageRow
	progress: (phase: string, message: string) => void

	deadPlacetypes?: readonly string[]
	/**
	 * Judge and count while staging no row and opening no transaction.
	 */
	dryRun?: boolean
	/**
	 * Receives one report per country judged (a country with no dump or no dead rows reports zero outcomes).
	 */
	onCountry?: (report: CurrencyBackfillCountryReport) => void
}): Promise<number> {
	const deadPlacetypes = ctx.deadPlacetypes ?? DEFAULT_DEAD_PLACETYPES
	const dryRun = ctx.dryRun === true

	if (!dryRun && !ctx.tx) {
		throw new Error(
			"resurrectCurrencyHoles: a build run needs the candidate transaction (tx); pass dryRun to judge only"
		)
	}

	const deadStmt = ctx.src.prepare(
		`SELECT id, name, placetype, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude
		 FROM spr
		 WHERE country = ? AND placetype IN (${deadPlacetypes.map(() => "?").join(", ")})
		   AND is_current = 0 AND is_deprecated = 1 AND is_superseded = 0`
	)

	const liveStmt = ctx.src.prepare(
		`SELECT latitude, longitude, placetype FROM spr WHERE country = ? AND name = ? AND is_current != 0`
	)

	let total = 0

	for (const country of ctx.countries) {
		const cc = country.toUpperCase()
		const dumpPath = resolvePath(ctx.geonamesDir, `${cc}.txt`)

		const report: CurrencyBackfillCountryReport = {
			country: cc,
			deadPlacetypes,
			dumpPresent: await pathExists(dumpPath),
			...emptyOutcomes(),
			byDeadPlacetype: {},
			sample: [],
		}

		if (!report.dumpPresent) {
			ctx.progress("currency-backfill", `${cc}: no GeoNames dump at ${dumpPath} — holes stay dead`)
			ctx.onCountry?.(report)

			continue
		}

		// Read dead rows first.
		// A country with no dead names then avoids loading its national dump.
		// That avoids heap pressure on a build near its limit.
		const dead = deadStmt.all(cc, ...deadPlacetypes)

		if (!dead.length) {
			ctx.progress("currency-backfill", `${cc}: 0 dead names — dump not loaded`)
			ctx.onCountry?.(report)

			continue
		}

		// Only the dead names' own folded keys can ever be probed, so the rest of the
		// national dump streams through without residency.
		const deadKeys = new Set<string>()

		for (const d of dead) {
			const k = normalizeLocalityForKey(String(d.name ?? ""))

			if (k) {
				deadKeys.add(k)
			}
		}

		// GeoNames columns by index: 1 name, 2 ascii, 4 lat, 5 lon, 6 feature_class, 14 population.
		const attestors = new Map<string, { lat: number; lon: number; pop: number }[]>()

		for await (const f of TSVSpliterator.fromAsync(dumpPath, { header: false })) {
			if (f[6] !== "P") continue

			const keys = [normalizeLocalityForKey(String(f[1] ?? "")), normalizeLocalityForKey(String(f[2] ?? ""))].filter(
				(key) => key && deadKeys.has(key)
			)

			if (!keys.length) continue

			const row = { lat: Number(f[4]), lon: Number(f[5]), pop: Number(f[14]) || 0 }

			for (const key of new Set(keys)) {
				const bag = attestors.get(key)

				if (bag) {
					bag.push(row)
				} else {
					attestors.set(key, [row])
				}
			}
		}

		const seen = new Set<string>()

		const count = (deadPlacetype: string, outcome: keyof CurrencyBackfillOutcomes): void => {
			report[outcome] += 1
			const bucket = (report.byDeadPlacetype[deadPlacetype] ??= emptyOutcomes())

			bucket[outcome] += 1
		}

		if (!dryRun) {
			ctx.tx!.exec("BEGIN")
		}

		for (const d of dead) {
			const name = String(d.name ?? "")
			const pkey = normalizeLocalityForKey(name)

			if (!pkey || seen.has(pkey)) continue
			seen.add(pkey)
			// The query admits whatever `deadPlacetypes` names, so the rank comparison
			// judges each candidate against its own dead rung.
			const deadPlacetype = String(d.placetype ?? "locality")

			count(deadPlacetype, "judged")
			const dLat = Number(d.latitude)
			const dLon = Number(d.longitude)

			// A live row blocks unless it is strictly finer than the dead one.
			// An unranked placetype also blocks because the failure mode is inventing a place.
			const liveNear = liveStmt.all(cc, name).some((row) => {
				if (haversineKm(dLat, dLon, Number(row.latitude), Number(row.longitude)) > CURRENCY_BACKFILL_RADIUS_KM) {
					return false
				}

				return isStrictlyFiner(String(row.placetype ?? ""), deadPlacetype) !== true
			})

			if (liveNear) {
				count(deadPlacetype, "blocked")

				continue
			}

			const near = (attestors.get(pkey) ?? []).filter(
				(g) => haversineKm(dLat, dLon, g.lat, g.lon) <= CURRENCY_BACKFILL_RADIUS_KM
			)

			if (!near.length) {
				count(deadPlacetype, "unattested")

				continue
			}

			const pop = Math.max(...near.map((g) => g.pop))

			if (pop < CURRENCY_BACKFILL_POP_FLOOR) {
				count(deadPlacetype, "floored")

				continue
			}

			count(deadPlacetype, "resurrected")

			if (report.sample.length < REPORT_SAMPLE_SIZE) {
				report.sample.push(`${deadPlacetype}:${name}`)
			}

			if (dryRun) continue

			const sid = Number(d.id)

			const a: PlaceAttrs = {
				cid: ctx.ccID(cc),
				rid: ctx.regionOf.get(sid) ?? 0,
				ptid: ctx.ptID(deadPlacetype),
				name,
				lat: dLat,
				lon: dLon,
				mnLat: Number(d.min_latitude),
				mnLon: Number(d.min_longitude),
				mxLat: Number(d.max_latitude),
				mxLon: Number(d.max_longitude),
				pop,
				neg: -Math.log10(pop + 1),
				pkey,
				imp: ctx.importance?.find(name, cc, deadPlacetype, dLat, dLon) ?? null,
			}

			ctx.attrs.set(sid, a)
			ctx.stageRow(pkey, a, sid, 1)
		}

		if (!dryRun) {
			ctx.tx!.exec("COMMIT")
		}

		ctx.progress(
			"currency-backfill",
			`${cc}: ${report.resurrected} resurrected of ${report.judged} dead names ` +
				`(${report.blocked} blocked by a live near row, ${report.unattested} unattested, ` +
				`${report.floored} under the population floor)${dryRun ? " — dry run, nothing staged" : ""}`
		)

		ctx.onCountry?.(report)
		total += report.resurrected
	}

	return total
}
