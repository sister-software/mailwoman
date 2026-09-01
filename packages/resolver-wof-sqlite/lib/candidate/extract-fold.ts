/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Pass 4 of the candidate build — fold a postcode or locality extract into the staging table.
 */

import { DatabaseClient } from "@mailwoman/sqlite/client"
import { tableExists } from "@mailwoman/sqlite/introspection"

import type { CandidateDatabase } from "#candidate-schema"
import type { PlaceAttrs, StageRow } from "#candidate/place-attrs"
import type { WOFDatabase } from "#schema"
import { normalizeLocalityForKey } from "#street/normalize"

/**
 * Fold ONE extract (`spr` rows at `extractPlacetype` carrying real coordinates) in, then pass 4b: the alias names
 * hanging off that same extract's `names` table.
 *
 * Self-contained by construction — it shares only the staging statement and the code dictionaries with the admin passes
 * above it, and nothing downstream reads anything it produces except the two counters it returns.
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
	progress: (phase: string, message: string) => void
}): { primaries: number; aliases: number } {
	const { out, extractPath, extractPlacetype, ccID, ptID, stageRow, progress } = ctx

	progress(extractPlacetype === "postalcode" ? "postcodes" : "localities", `reading ${extractPath}`)

	using pc = new DatabaseClient<WOFDatabase>(extractPath, { readOnly: true })
	const pcPtid = ptID(extractPlacetype)
	// Per-extract, not the admin `attrs` map: pass 1 only ever sees the admin DB, so the alias pass
	// below has nothing to join against unless this primary loop records what it staged.
	const pcAttrs = new Map<number, PlaceAttrs>()
	let primaries = 0
	let aliases = 0

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

		// region_id 0 (a postcode is unique by name+country — no same-name disambiguation); neg_rank 0
		// (no population). bbox = the postcode's own min/max (falls back to the centroid point).
		const a: PlaceAttrs = {
			cid: ccID(r.country as string | null),
			rid: 0,
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

		pcAttrs.set(Number(r.id), a)
		stageRow(key, a, Number(r.id), 1)

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

	return { primaries, aliases }
}
