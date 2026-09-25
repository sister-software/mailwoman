/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseClient } from "@mailwoman/sqlite/client"
import { tableExists } from "@mailwoman/sqlite/introspection"
import type { PathBuilderLike } from "path-ts"

import { CANDIDATE_ANCESTOR_COLUMNS, CANDIDATE_ANCESTOR_TABLE } from "#candidate/ancestors/schema"
import type { PlaceAttrs, StageRow } from "#candidate/place-attrs"
import type { CandidateDatabase } from "#candidate/schema"
import type { WOFDatabase } from "#schema"
import { normalizeLocalityForKey } from "#street/normalize"

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
 * Stages one postcode or locality extract's located `spr` rows and their `names`
 * aliases into the candidate table.
 *
 * When the extract names a row's region, it also writes that row's ancestor chain through
 * the region, so the stamped ancestors agree with the scope the row is found under.
 */
export function foldExtract(ctx: {
	out: DatabaseClient<CandidateDatabase>
	extractPath: PathBuilderLike
	extractPlacetype: "postalcode" | "locality"
	ccID: (code: string | null) => number
	ptID: (pt: string | null) => number
	stageRow: StageRow

	attrs?: Map<number, PlaceAttrs>
	progress: (phase: string, message: string) => void
}): { primaries: number; aliases: number; scoped: number; ancestorRows: number } {
	const { out, extractPath, extractPlacetype, ccID, ptID, stageRow, progress } = ctx

	progress(extractPlacetype === "postalcode" ? "postcodes" : "localities", `reading ${extractPath}`)

	using pc = new DatabaseClient<WOFDatabase>(extractPath, { readOnly: true })
	const pcPtid = ptID(extractPlacetype)

	const pcAttrs = new Map<number, PlaceAttrs>()
	const regionOf = ctx.attrs ? extractRegionAncestry(pc, ctx.attrs) : new Map<number, number>()

	const insAncestor = out.prepare(
		`INSERT OR IGNORE INTO ${CANDIDATE_ANCESTOR_TABLE} VALUES (${CANDIDATE_ANCESTOR_COLUMNS.map(() => "?").join(", ")})`
	)

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

	const hasNames = tableExists(pc, "names")

	if (hasNames) {
		out.exec("BEGIN")

		for (const r of pc.prepare("SELECT id, name FROM names").iterate()) {
			const a = pcAttrs.get(Number(r.id))

			if (!a) continue

			const k = normalizeLocalityForKey(String(r.name ?? ""))

			if (!k || k === a.pkey) continue

			stageRow(k, a, Number(r.id), 0)

			aliases++
		}

		out.exec("COMMIT")
	} else {
		progress("postcode-aliases", `${extractPath} has no \`names\` table — no delivery-city aliases to fold`)
	}

	return { primaries, aliases, scoped, ancestorRows }
}
