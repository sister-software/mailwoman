/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pass 1c of the candidate build (#1737): resurrect deprecated-with-no-successor WOF localities that a second
 *   source independently attests. Extracted from `build-candidate.ts` as a cohesive unit — the checks, their measured
 *   constants, and the GeoNames dump reader live together here; the build calls {@link resurrectCurrencyHoles} once,
 *   between the primaries pass and the alias pass.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { isStrictlyFiner } from "@mailwoman/core/resources/whosonfirst"
import { haversineKm } from "@mailwoman/spatial"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { resolvePath } from "path-ts"
import { TSVSpliterator } from "spliterator"

import type { loadImportanceIndex } from "#candidate-importance"
import type { CandidateDatabase } from "#candidate-schema"
import type { PlaceAttrs, StageRow } from "#candidate/place-attrs"
import type { WOFDatabase } from "#schema"
import { normalizeLocalityForKey } from "#street/normalize"

/**
 * Corroboration radius for the currency backfill (#1737), km — both for the live-near blocker and the GeoNames
 * attestation. Measured basis (2026-08-19 prototype, GB locality slice): at 10 km, 20 of 108 dead names resurrect —
 * Rochester (Kent), Aldershot, Staines, Telford, Ebbw Vale among them — while the `Birmingham/Wolverhampton/…`
 * conurbation blobs stay dead (no attestation) and Swansea/Wrexham stay out because a live same-name row already serves
 * them within the radius.
 */
const CURRENCY_BACKFILL_RADIUS_KM = 10

/**
 * Minimum attestor population for a resurrection. The same prototype measured 44 of 108 dead GB names attested but
 * under this floor — hamlet-scale ghosts whose absence from the index nobody has reported. A floor keeps the pass
 * answering the measured defect (real settlements) rather than re-importing the tail WOF chose to prune.
 */
const CURRENCY_BACKFILL_POP_FLOOR = 1000

/**
 * Pass 1c (#1737): resurrect deprecated-with-no-successor localities that a second source independently attests.
 *
 * WOF deprecations WITH a successor need nothing — the successor indexes. A deprecation with `is_superseded = 0` on a
 * populated place is the shape of an upstream mistake (Rochester Kent, Aldershot, Telford; 120 GB localities alone),
 * and it is indistinguishable from a correct pruning at this layer without outside evidence. So every resurrection
 * requires all three conditions, positive evidence only:
 *
 * 1. NO live same-name spr row of any placetype within {@link CURRENCY_BACKFILL_RADIUS_KM} of the dead record — a live row
 *    means the place is alive (possibly under another placetype) and there is no hole. A DISTANT same-name row is a
 *    namesake and does not block.
 * 2. A GeoNames feature-class-P attestation of the same folded name within the radius.
 * 3. The attestor at or above {@link CURRENCY_BACKFILL_POP_FLOOR}.
 *
 * The staged row keeps the WOF identity — id, name, centroid, bbox, region ancestry — because the dead record's own
 * data is not what is wrong with it. GeoNames contributes exactly two things: the attestation, and the population that
 * lets the row stand in prominence races (the dead record's own population is absent). Each name is judged once per
 * country; the resurrected place joins `attrs`, so the alias pass explodes its alt names like any primary's.
 */
export interface CurrencyBackfillOutcomes {
	judged: number
	blocked: number
	unattested: number
	floored: number
	resurrected: number
}

/**
 * One country's read of the gate — every dead name judged, by outcome and by the dead row's placetype — so a census can
 * say what a wider dead-row query admits before a build carries it.
 */
export interface CurrencyBackfillCountryReport extends CurrencyBackfillOutcomes {
	country: string
	deadPlacetypes: readonly string[]
	dumpPresent: boolean
	byDeadPlacetype: Record<string, CurrencyBackfillOutcomes>
	/**
	 * The first resurrected names, `placetype:name`, so a census reads what a wider query admits — capped, because the
	 * report is a receipt and not the table.
	 */
	sample: string[]
}

const REPORT_SAMPLE_SIZE = 25

/**
 * The placetypes a dead row may carry to be judged at all. `locality` is the shipped default; `localadmin` is the
 * second cause #1746 named (one GB row of seventeen) and is admitted through this option once its census is read.
 */
export const DEFAULT_DEAD_PLACETYPES: readonly string[] = ["locality"]

function emptyOutcomes(): CurrencyBackfillOutcomes {
	return { judged: 0, blocked: 0, unattested: 0, floored: 0, resurrected: 0 }
}

export async function resurrectCurrencyHoles(ctx: {
	src: DatabaseClient<WOFDatabase>
	/**
	 * The candidate build's transaction. Required unless `dryRun` — a dry run judges every row and stages nothing.
	 */
	tx?: DatabaseClient<CandidateDatabase>
	geonamesDir: string
	countries: readonly string[]
	attrs: Map<number, PlaceAttrs>
	ccID: (code: string | null) => number
	ptID: (pt: string | null) => number
	regionOf: Map<number, number>
	importance: ReturnType<typeof loadImportanceIndex> | undefined
	stageRow: StageRow
	progress: (phase: string, message: string) => void
	/**
	 * Which dead placetypes are judged. Default {@link DEFAULT_DEAD_PLACETYPES}.
	 */
	deadPlacetypes?: readonly string[]
	/**
	 * Judge and count, stage nothing — the census mode. No transaction is opened.
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

		// Dead rows FIRST: a country with no deprecated-no-successor localities needs no attestors at all, and
		// loading a national dump to judge zero rows is pure heap pressure on a build already near its ceiling
		// (the first live run OOM'd in a later pass with JP/KR dumps loaded for 0 dead names each).
		const dead = deadStmt.all(cc, ...deadPlacetypes)

		if (!dead.length) {
			ctx.progress("currency-backfill", `${cc}: 0 dead names — dump not loaded`)
			ctx.onCountry?.(report)

			continue
		}

		// Only the dead names' own folded keys can ever be probed, so only those keys are worth holding —
		// the rest of the national dump streams through without residency.
		const deadKeys = new Set<string>()

		for (const d of dead) {
			const k = normalizeLocalityForKey(String(d.name ?? ""))

			if (k) {
				deadKeys.add(k)
			}
		}

		// Folded name → P-class attestors. GeoNames columns by index: 1 name, 2 ascii, 4 lat, 5 lon,
		// 6 feature_class, 14 population.
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
			// Read from the row: the query admits whatever `deadPlacetypes` names, and the rank comparison below must
			// judge each candidate against ITS dead rung, never a hardcoded one.
			const deadPlacetype = String(d.placetype ?? "locality")

			count(deadPlacetype, "judged")
			const dLat = Number(d.latitude)
			const dLon = Number(d.longitude)

			// A live row blocks only when it is AT LEAST AS COARSE as the dead one. The original check compared name and
			// distance alone, on the premise that a nearby same-name row means "the place is alive under another
			// placetype" — true for a place recorded twice, false for a placetype DEMOTION, which is the shape that
			// actually occurs: WOF retired `Gillingham` the locality (pop 101,187) and kept `Gillingham` the
			// neighbourhood 3.2 km away, and the check read the surviving CHILD as covering its own dead parent.
			// Sixteen of seventeen GB refusals had exactly that shape (#1746).
			//
			// An UNRANKED placetype blocks, which is the conservative direction: this check's failure mode is inventing
			// a place, so a row we cannot rank is treated as covering rather than waved through.
			const liveNear = liveStmt.all(cc, name).some((row) => {
				if (haversineKm(dLat, dLon, Number(row.latitude), Number(row.longitude)) > CURRENCY_BACKFILL_RADIUS_KM) {
					return false
				}

				// Blocks UNLESS the live row is strictly finer. The equal rung must still block — a live `locality`
				// covers a dead `locality` — and an unranked placetype blocks too, since this check's failure mode
				// is inventing a place.
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
