/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pass 1c of the candidate build (#1737): resurrect deprecated-with-no-successor WOF localities that a second
 *   source independently attests. Extracted from `build-candidate.ts` as a cohesive unit — the gates, their measured
 *   constants, and the GeoNames dump reader live together here; the build calls {@link resurrectCurrencyHoles} once,
 *   between the primaries pass and the alias pass.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { DatabaseSync } from "node:sqlite"

import { isStrictlyFiner } from "@mailwoman/core/resources/whosonfirst"
import { haversineKm } from "@mailwoman/spatial"
import { TSVSpliterator } from "spliterator"

import type { loadImportanceIndex } from "./candidate-importance.ts"
import type { PlaceAttrs, StageRow } from "./candidate/place-attrs.ts"
import { normalizeLocalityForKey } from "./street-normalize.ts"

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
 * requires all three gates, positive evidence only:
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
export async function resurrectCurrencyHoles(ctx: {
	src: DatabaseSync
	tx: DatabaseSync
	geonamesDir: string
	countries: readonly string[]
	attrs: Map<number, PlaceAttrs>
	ccID: (code: string | null) => number
	ptID: (pt: string | null) => number
	regionOf: Map<number, number>
	importance: ReturnType<typeof loadImportanceIndex> | undefined
	stageRow: StageRow
	progress: (phase: string, message: string) => void
}): Promise<number> {
	const deadStmt = ctx.src.prepare(
		`SELECT id, name, placetype, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude
		 FROM spr
		 WHERE country = ? AND placetype = 'locality'
		   AND is_current = 0 AND is_deprecated = 1 AND is_superseded = 0`
	)

	const liveStmt = ctx.src.prepare(
		`SELECT latitude, longitude, placetype FROM spr WHERE country = ? AND name = ? AND is_current != 0`
	)

	let total = 0

	for (const country of ctx.countries) {
		const cc = country.toUpperCase()
		const dumpPath = resolve(ctx.geonamesDir, `${cc}.txt`)

		if (!existsSync(dumpPath)) {
			ctx.progress("currency-backfill", `${cc}: no GeoNames dump at ${dumpPath} — holes stay dead`)

			continue
		}

		// Dead rows FIRST: a country with no deprecated-no-successor localities needs no attestors at all, and
		// loading a national dump to judge zero rows is pure heap pressure on a build already near its ceiling
		// (the first live run OOM'd in a later pass with JP/KR dumps loaded for 0 dead names each).
		const dead = deadStmt.all(cc)

		if (!dead.length) {
			ctx.progress("currency-backfill", `${cc}: 0 dead names — dump not loaded`)

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

		let judged = 0
		let blocked = 0
		let unattested = 0
		let floored = 0
		let resurrected = 0
		const seen = new Set<string>()

		ctx.tx.exec("BEGIN")

		for (const d of dead) {
			const name = String(d.name ?? "")
			const pkey = normalizeLocalityForKey(name)

			if (!pkey || seen.has(pkey)) continue
			seen.add(pkey)

			judged++

			const dLat = Number(d.latitude)
			const dLon = Number(d.longitude)
			// The dead-row query is scoped to `locality` today; read it from the row anyway so widening that query
			// cannot silently start comparing every candidate against a hardcoded rung.
			const deadPlacetype = String(d.placetype ?? "locality")

			// A live row blocks only when it is AT LEAST AS COARSE as the dead one. The original gate compared name and
			// distance alone, on the premise that a nearby same-name row means "the place is alive under another
			// placetype" — true for a place recorded twice, false for a placetype DEMOTION, which is the shape that
			// actually occurs: WOF retired `Gillingham` the locality (pop 101,187) and kept `Gillingham` the
			// neighbourhood 3.2 km away, and the gate read the surviving CHILD as covering its own dead parent.
			// Sixteen of seventeen GB refusals had exactly that shape (#1746).
			//
			// An UNRANKED placetype blocks, which is the conservative direction: this gate's failure mode is inventing
			// a place, so a row we cannot rank is treated as covering rather than waved through.
			const liveNear = liveStmt.all(cc, name).some((row) => {
				if (haversineKm(dLat, dLon, Number(row.latitude), Number(row.longitude)) > CURRENCY_BACKFILL_RADIUS_KM) {
					return false
				}

				// Blocks UNLESS the live row is strictly finer. The equal rung must still block — a live `locality`
				// covers a dead `locality` — and an unranked placetype blocks too, since this gate's failure mode
				// is inventing a place.
				return isStrictlyFiner(String(row.placetype ?? ""), deadPlacetype) !== true
			})

			if (liveNear) {
				blocked++

				continue
			}

			const near = (attestors.get(pkey) ?? []).filter(
				(g) => haversineKm(dLat, dLon, g.lat, g.lon) <= CURRENCY_BACKFILL_RADIUS_KM
			)

			if (!near.length) {
				unattested++

				continue
			}

			const pop = Math.max(...near.map((g) => g.pop))

			if (pop < CURRENCY_BACKFILL_POP_FLOOR) {
				floored++

				continue
			}

			const sid = Number(d.id)

			const a: PlaceAttrs = {
				cid: ctx.ccID(cc),
				rid: ctx.regionOf.get(sid) ?? 0,
				ptid: ctx.ptID("locality"),
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
				imp: ctx.importance?.find(name, cc, "locality", dLat, dLon) ?? null,
			}

			ctx.attrs.set(sid, a)
			ctx.stageRow(pkey, a, sid, 1)

			resurrected++
		}

		ctx.tx.exec("COMMIT")

		ctx.progress(
			"currency-backfill",
			`${cc}: ${resurrected} resurrected of ${judged} dead names ` +
				`(${blocked} blocked by a live near row, ${unattested} unattested, ${floored} under the population floor)`
		)

		total += resurrected
	}

	return total
}
