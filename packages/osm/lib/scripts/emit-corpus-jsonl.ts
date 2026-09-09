/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Emit the per-country corpus JSONL the `@mailwoman/corpus` `osm` adapter reads, from a Geofabrik `.osm.pbf` extract.
 *   The heavy half (GDAL over the PBF) runs here; the adapter streams the result. See `sdk/corpus-jsonl.ts` for the row
 *   shape and the ODbL note.
 *
 *   Usage:
 *     node packages/osm/out/scripts/emit-corpus-jsonl.js \
 *       --pbf $MAILWOMAN_DATA_ROOT/osm/geofabrik/pakistan-260819.osm.pbf \
 *       --out $MAILWOMAN_DATA_ROOT/osm/corpus/osm-pk.corpus.jsonl
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { writeOSMCorpusJSONL } from "#sdk/corpus-jsonl"

const { values } = parseArguments({
	options: {
		pbf: { type: "string" },
		out: { type: "string" },
	},
})

if (!values.pbf || !values.out) {
	throw new Error("usage: emit-corpus-jsonl --pbf <extract.osm.pbf> --out <osm-<cc>.corpus.jsonl>")
}

const stats = await writeOSMCorpusJSONL(values.pbf, values.out)

console.log(
	`[osm] ${values.out}: ${stats.written} rows written, ${stats.noStreet} features without addr:street skipped, ${stats.read} read`
)
