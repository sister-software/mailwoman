/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Pass 4 of the candidate build — fold a postcode or locality extract into the staging table.
 */

import { DatabaseClient } from "@mailwoman/sqlite/client"
import { tableExists } from "@mailwoman/sqlite/introspection"

import { CANDIDATE_ANCESTOR_COLUMNS, CANDIDATE_ANCESTOR_TABLE } from "#candidate-ancestors-schema"
import type { CandidateDatabase } from "#candidate-schema"
import type { PlaceAttrs, StageRow } from "#candidate/place-attrs"
import type { WOFDatabase } from "#schema"
import { normalizeLocalityForKey } from "#street/normalize"

/**
 * The extract's own region-tier ancestry, when it carries any: extract id → the admin region's id. A locality extract
 * derived from a national register (the Taiwanese 鄉鎮市區 from the civil-affairs address points) knows which 縣市 each row
 * belongs to, and writes that as an `ancestors` row against the admin region's WOF id. Without it a folded row has no
 * region scope, so a `parentID`-scoped probe misses it and the cascade widens to whatever namesake carries the key.
 *
 * Only a region the admin build staged (`attrs`) counts: an id the admin does not know cannot be denormalized into a
 * closure row, and a scope nothing can match would be a silent zero rather than an absence.
 */
function extractRegionAncestry(pc: DatabaseClient<WOFDatabase>, attrs: Map<number, PlaceAttrs>): Map<number, number> {
	const regionOf = new Map<number, number>()

	if (!tableExists(pc, "ancestors")) {
		return regionOf
	}

	for (const r of pc
		.prepare(
			"SELECT id, MIN(ancestor_id) AS ancestor_id FROM ancestors WHERE ancestor_placetype = 'region' GROUP BY id"
		)
		.iterate()) {
		const rid = Number(r.ancestor_id)

		if (attrs.has(rid)) {
			regionOf.set(Number(r.id), rid)
		}
	}

	return regionOf
}

/**
 * Fold ONE extract (`spr` rows at `extractPlacetype` carrying real coordinates) in, then pass 4b: the alias names
 * hanging off that same extract's `names` table.
 *
 * Self-contained by construction — it shares only the staging statement and the code dictionaries with the admin passes
 * above it, and nothing downstream reads anything it produces except the counters it returns. The one thing it writes
 * beyond the staging table is a depth-1 closure row for a row whose extract names its region (see
 * {@link extractRegionAncestry}), so the pick's stamped ancestors agree with the scope it was found under.
 */
export function foldExtract(ctx: {
	/**
	 * The staging connection. The extract itself is opened read-only here and closed before returning.
	 */
	out: DatabaseClient<CandidateDatabase>
	extractPath: string
	extractPlacetype: "postalcode" | "locality"
	ccID: (code: string | null) => number
	ptID: (pt: string | null) => number
	stageRow: StageRow
	/**
	 * The admin places pass 1 staged — what an extract's region ancestry is resolved against. Absent, no extract row
	 * takes a region scope (the postcode extracts, which carry none).
	 */
	attrs?: Map<number, PlaceAttrs>
	progress: (phase: string, message: string) => void
}): { primaries: number; aliases: number; scoped: number; ancestorRows: number } {
	const { out, extractPath, extractPlacetype, ccID, ptID, stageRow, progress } = ctx

	progress(extractPlacetype === "postalcode" ? "postcodes" : "localities", `reading ${extractPath}`)

	using pc = new DatabaseClient<WOFDatabase>(extractPath, { readOnly: true })
	const pcPtid = ptID(extractPlacetype)
	// Per-extract, not the admin `attrs` map: pass 1 only ever sees the admin DB, so the alias pass
	// below has nothing to join against unless this primary loop records what it staged.
	const pcAttrs = new Map<number, PlaceAttrs>()
	const regionOf = ctx.attrs ? extractRegionAncestry(pc, ctx.attrs) : new Map<number, number>()

	const insAncestor = out.prepare(
		`INSERT OR IGNORE INTO ${CANDIDATE_ANCESTOR_TABLE} VALUES (${CANDIDATE_ANCESTOR_COLUMNS.map(() => "?").join(", ")})`
	)

	// The region's own closure rows, as the sidecar pass wrote them. A scoped row inherits the whole chain above its
	// region — macroregion, country — not the region alone: the widened-scope refusal reads a pick's stamped ancestors
	// against the parent the walk resolved, and a 縣市 that resolves to its macroregion record (`桃園市`, which WOF names
	// only at that tier) would otherwise contradict a lineage that stops at the region.
	const regionChain = out.prepare(
		`SELECT depth, parent_spr_id, parent_placetype_id, parent_name, parent_name_key FROM ${CANDIDATE_ANCESTOR_TABLE} WHERE spr_id = ? ORDER BY depth`
	)

	let primaries = 0
	let aliases = 0
	let scoped = 0
	let ancestorRows = 0

	out.exec("BEGIN")

	for (const r of pc
		.prepare(
			`SELECT id, name, country, latitude, longitude,
				min_latitude AS mnlat, min_longitude AS mnlon, max_latitude AS mxlat, max_longitude AS mxlon
			 FROM spr WHERE placetype = ? AND latitude != 0 AND longitude != 0`
		)
		.iterate(extractPlacetype)) {
		const name = String(r.name ?? "")
		const key = normalizeLocalityForKey(name)

		if (!key) continue

		const lat = r.latitude as number
		const lon = r.longitude as number
		const id = Number(r.id)
		const rid = regionOf.get(id) ?? 0

		// region_id from the extract's own ancestry when it names one, else 0 (a postcode is unique by
		// name+country — no same-name disambiguation); neg_rank 0 (no population). bbox = the row's own
		// min/max (falls back to the centroid point).
		const a: PlaceAttrs = {
			cid: ccID(r.country as string | null),
			rid,
			ptid: pcPtid,
			name,
			lat,
			lon,
			mnLat: (r.mnlat as number) || lat,
			mnLon: (r.mnlon as number) || lon,
			mxLat: (r.mxlat as number) || lat,
			mxLon: (r.mxlon as number) || lon,
			pop: 0,
			neg: 0,
			pkey: key,
			// A postcode has no toponym fame — nobody writes an encyclopedia article about SW1A 2AA — and
			// the score source carries no `postalcode` rows to join against anyway. NULL is the truthful
			// value: unmeasured, so the ranking key leaves postcode rows exactly where they were.
			imp: null,
		}

		pcAttrs.set(id, a)
		stageRow(key, a, id, 1)

		if (rid !== 0) {
			const region = ctx.attrs!.get(rid)!

			insAncestor.run(id, 1, rid, region.ptid, region.name, region.pkey)

			scoped++

			ancestorRows++

			for (const link of regionChain.iterate(rid)) {
				insAncestor.run(
					id,
					Number(link.depth) + 1,
					Number(link.parent_spr_id),
					Number(link.parent_placetype_id),
					String(link.parent_name ?? ""),
					String(link.parent_name_key ?? "")
				)

				ancestorRows++
			}
		}

		primaries++
	}

	out.exec("COMMIT")

	// --- pass 4b: postcode ALIAS names (#1495) ---
	//
	// The delivery-city names GeoNames supplies for a ZIP ("Brooklyn" for 11201) are written into
	// the extract's `names` table by `postcode/centroid-fills.ts`'s `geonamesNameFill`. Everything
	// downstream of `names` picked them up EXCEPT this build: `fts.ts` unions `spr.name` with every
	// `names` row into `place_search.alt_names`, so the FTS backend resolved "Brooklyn" → 11201
	// while the candidate backend — whose every row IS an exact-tier row — had no key for it at
	// all. Pass 2 does the equivalent fold for admin places, but reads the ADMIN `place_search`,
	// and `attrs` holds admin ids only, so a postcode extract could never reach it.
	//
	// Same discipline as pass 2: `is_primary = 0` (so `rankByPrimaryPreference` treats it as an
	// alias, not a canonical postcode name), the row stays denormalized onto the POSTCODE's own
	// spr_id/coords/bbox, and the display `name` stays the postcode — resolving "brooklyn" answers
	// with place 11201, it does not rename the place to its delivery city.
	const hasNames = tableExists(pc, "names")

	if (hasNames) {
		out.exec("BEGIN")

		for (const r of pc.prepare("SELECT id, name FROM names").iterate()) {
			const a = pcAttrs.get(Number(r.id))

			if (!a) continue

			const k = normalizeLocalityForKey(String(r.name ?? ""))

			// The postcode's own key is already staged as the primary; `INSERT OR IGNORE` at
			// materialization dedupes repeats, so this only skips the obvious self-alias.
			if (!k || k === a.pkey) continue

			stageRow(k, a, Number(r.id), 0)

			aliases++
		}

		out.exec("COMMIT")
	} else {
		// Never a silent zero: real extracts come from `createUnifiedSchema`, which always creates
		// `names`. A extract without it has no alias surface to lose, but say so rather than reporting
		// "0 aliases" from a table that was never read.
		progress("postcode-aliases", `${extractPath} has no \`names\` table — no delivery-city aliases to fold`)
	}

	return { primaries, aliases, scoped, ancestorRows }
}
