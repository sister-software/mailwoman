// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Emit the per-country corpus jsonl the `@mailwoman/corpus` `osm` adapter reads,
 *   from a Geofabrik `.osm.pbf` extract.
 *
 *   The heavy half (gdal over the PBF) runs here.
 *   The adapter streams the result.
 *
 *   See `sdk/corpus-jsonl.ts` for the row shape and the ODbL note.
 *
 *   `--within` names a country outline (`tools/fetch/country-outline.ts` writes them).
 *   A Geofabrik extract holds addresses across the country's land borders,
 *   and a record whose point lies outside the outline is counted and left out.
 *
 *   `--without` may appear more than once.
 *   Each occurrence takes a neighbor's outline.
 *
 *   A record inside one is left out too.
 *   That settles a border where the country's own outline is coarser than its neighbor's.
 *
 *   `--locality-level` takes an `admin_level` whose `boundary=administrative` areas in the same
 *   extract supply the locality of a record without `addr:city` (Serbia's settlements are level 9).
 *   It repeats, in priority order.
 *
 *   `--dependent-locality-level` does the same for a record without `addr:suburb`.
 *   The names land in `boundary_locality` and `boundary_dependent_locality` rather than
 *   in the tag fields, so a row still records which value a mapper tagged.
 *
 *   `--region` reads the newest vintage of a Geofabrik region under
 *   `$MAILWOMAN_DATA_ROOT/snapshots/geofabrik/`, or the one `--vintage` names.
 *   `--pbf` reads any other file.
 *
 *   Usage:
 *     node packages/osm/tools/emit-corpus-jsonl.ts \
 *       --region asia/china --vintage 2026-10-02 \
 *       --within $MAILWOMAN_DATA_ROOT/db/osm/outlines/CHN-ADM0.geojson \
 *       --out $MAILWOMAN_DATA_ROOT/db/osm/corpus/osm-cn.corpus.jsonl
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import type { ParsedGeometry } from "@mailwoman/spatial"

import { createAdminAreaLookup } from "#sdk/admin-area-lookup"
import { type AreaNamer, writeOSMCorpusJSONL } from "#sdk/corpus-jsonl"
import { createOutlineContainment } from "#sdk/country-outline"
import { extractOSMAdminAreas } from "#sdk/extract/boundary"
import { extractReceiptPath } from "#sdk/extract/receipt"
import { resolveExtractOption } from "#sdk/geofabrik/snapshot"

const { values } = parseArguments({
	options: {
		pbf: { type: "string" },
		region: { type: "string" },
		vintage: { type: "string" },
		out: { type: "string" },
		within: { type: "string" },
		without: { type: "string", multiple: true },
		"locality-level": { type: "string", multiple: true },
		"dependent-locality-level": { type: "string", multiple: true },
	},
})

const extract = await resolveExtractOption(values)

if (!extract || !values.out) {
	throw new Error(
		"usage: emit-corpus-jsonl (--pbf <extract.osm.pbf> | --region <geofabrik/path> [--vintage <YYYY-MM-DD>]) " +
			"--out <osm-<cc>.corpus.jsonl> [--within <outline>]"
	)
}

const { pbf } = extract
const out = values.out

/**
 * One outline file's containment test.
 * Several features join into one multipolygon.
 */
async function readOutline(path: string): Promise<(lon: number, lat: number) => boolean> {
	const collection = await readLocalJSONFile<{ features: { geometry: ParsedGeometry }[] }>(path)

	const polygons = collection.features.flatMap(({ geometry }) =>
		geometry.type === "Polygon"
			? [geometry.coordinates]
			: geometry.type === "MultiPolygon"
				? (geometry.coordinates as unknown[])
				: []
	)

	if (!polygons.length) throw new Error(`${path} holds no polygon`)

	return createOutlineContainment({ type: "MultiPolygon", coordinates: polygons } as ParsedGeometry)
}

const own = values.within ? await readOutline(values.within) : null
// A neighbor's outline can be drawn more finely than the country's own, so a point inside
// a neighbor is refused even where a coarse own outline also contains it.
const neighbors = await Promise.all((values.without ?? []).map(readOutline))

const within =
	own || neighbors.length
		? (lon: number, lat: number) => (own?.(lon, lat) ?? true) && !neighbors.some((inside) => inside(lon, lat))
		: null

const localityLevels = values["locality-level"] ?? []
const dependentLevels = values["dependent-locality-level"] ?? []
const levels = [...new Set([...localityLevels, ...dependentLevels])]
const areas = levels.length ? await extractOSMAdminAreas(pbf, levels) : []

/**
 * A namer over the boundaries at `wanted`, in priority order: the first level with
 * an area containing the point supplies the name.
 */
function namerFor(wanted: readonly string[]): AreaNamer | undefined {
	if (!wanted.length) return undefined

	const lookups = wanted.map((level) => createAdminAreaLookup(areas.filter((area) => area.adminLevel === level)))

	return (lon, lat) => {
		for (const lookup of lookups) {
			const area = lookup(lon, lat)

			if (area) return area.name
		}

		return null
	}
}

const stats = await writeOSMCorpusJSONL(pbf, out, {
	within: within ?? undefined,
	localityOf: namerFor(localityLevels),
	dependentLocalityOf: namerFor(dependentLevels),
})

// The sidecar is the first stage of the acquisition funnel: what the PBF held and what the
// extract wrote, beside the receipts that identify the PBF's bytes and the outline used.
await writeLocalJSONFile(
	{
		pbf,
		receipt: extractReceiptPath(pbf),
		outline: values.within ?? null,
		outline_receipt: values.within ? `${values.within}.receipt.json` : null,
		excluded_outlines: values.without ?? [],
		locality_levels: localityLevels,
		dependent_locality_levels: dependentLevels,
		boundary_areas: Object.fromEntries(
			levels.map((level) => [level, areas.filter((a) => a.adminLevel === level).length])
		),
		...stats,
	},
	`${out}.stats.json`
)

console.log(
	`[osm] ${out}:${stats.written} rows written (${stats.noStreet} without addr:street), ` +
		`${stats.outsideOutline ?? "unmeasured"} outside the outline, ${stats.read} read, ` +
		`${stats.localityFromBoundary ?? "no"} localities and ${stats.dependentLocalityFromBoundary ?? "no"} ` +
		`dependent localities named from ${areas.length} boundaries`
)
