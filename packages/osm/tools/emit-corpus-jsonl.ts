/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Emit the per-country corpus jsonl the `@mailwoman/corpus` `osm` adapter reads, from a Geofabrik `.osm.pbf` extract.
 *   The heavy half (gdal over the PBF) runs here. the adapter streams the result. See `sdk/corpus-jsonl.ts` for the row
 *   shape and the ODbL note.
 *
 *   `--within` names a country outline (`tools/fetch/country-outline.ts` writes them). A Geofabrik extract
 *   holds addresses across the country's land borders, and a record whose point lies outside the outline
 *   is counted and left out. `--without`, which repeats, takes a neighbor's outline. A record inside one
 *   is left out too. That settles a border where the country's own outline is coarser than its neighbor's.
 *
 *   Usage:
 *     node packages/osm/tools/emit-corpus-jsonl.ts \
 *       --pbf $MAILWOMAN_DATA_ROOT/db/osm/geofabrik/china-261002.osm.pbf \
 *       --within $MAILWOMAN_DATA_ROOT/db/osm/outlines/CHN-ADM0.geojson \
 *       --out $MAILWOMAN_DATA_ROOT/db/osm/corpus/osm-cn.corpus.jsonl
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import type { ParsedGeometry } from "@mailwoman/spatial"

import { writeOSMCorpusJSONL } from "#sdk/corpus-jsonl"
import { createOutlineContainment } from "#sdk/country-outline"

const { values } = parseArguments({
	options: {
		pbf: { type: "string" },
		out: { type: "string" },
		within: { type: "string" },
		without: { type: "string", multiple: true },
	},
})

if (!values.pbf || !values.out) {
	throw new Error("usage: emit-corpus-jsonl --pbf <extract.osm.pbf> --out <osm-<cc>.corpus.jsonl> [--within <outline>]")
}

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
		: undefined

const stats = await writeOSMCorpusJSONL(values.pbf, values.out, { within })

// The sidecar is the first stage of the acquisition funnel: what the PBF held and what the
// extract wrote, beside the receipts that identify the PBF's bytes and the outline used.
await writeLocalJSONFile(
	{
		pbf: values.pbf,
		receipt: `${values.pbf}.receipt.json`,
		outline: values.within ?? null,
		outline_receipt: values.within ? `${values.within}.receipt.json` : null,
		excluded_outlines: values.without ?? [],
		...stats,
	},
	`${values.out}.stats.json`
)

console.log(
	`[osm] ${values.out}: ${stats.written} rows written (${stats.noStreet} without addr:street), ` +
		`${stats.outsideOutline ?? "unmeasured"} outside the outline, ${stats.read} read`
)
