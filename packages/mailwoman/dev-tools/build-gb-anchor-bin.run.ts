/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the GB postcode-anchor binary (`postcode-gb.bin`, PCB1) that the anchor-v2 retrain's serving
 *   half needs — UNIT keys plus OUTWARD district keys, in the SPACE-STRIPPED UPPERCASE form the train
 *   painter writes (`SW1A 2AA` → `SW1A2AA`).
 *
 *   WHY THIS EXISTS RATHER THAN `mailwoman gazetteer postcode-binary --locale GB:<shard>`. That
 *   command's GB branch (`aggregateGbOutward`) derives the outward code by splitting `name` on a
 *   SPACE, because it was written against `postalcode-gb.db` (the retired GeoNames-lineage shard),
 *   whose `name` column carries the spaced display form. The licence-clean Code-Point Open shard
 *   (`postalcode-gb-codepoint.db`, OGL v3.0) stores `name` already space-stripped (`AB101AB`), so
 *   `gbOutward` returns null on every one of its 1,746,976 rows and the command writes a VALID,
 *   EMPTY, 0-code binary and reports success. Measured 2026-08-05:
 *
 *     mailwoman gazetteer postcode-binary --locale GB:postalcode-gb-codepoint.db
 *       → GB: 0 codes (0 placed) → postcode-gb.bin (0.00 MB)
 *
 *   It also aggregates GB to outward codes ONLY, which was right for a model whose GB slot never
 *   trained but is wrong for one trained against `pilot-anchor-lookup-v2` — that lookup carries
 *   1,746,976 UNIT keys plus 2,863 outward keys, and the unit centroid is what painted the training
 *   spans.
 *
 *   So the key set here is a verbatim mirror of the training lookup's GB half
 *   (`mailwoman/gazetteer-pipeline/anchor-lookup.ts::loadGBCodePoint` + `addGBOutwardKeys`): every
 *   Code-Point unit that matches the unit-key shape, plus one outward key per district placed at the
 *   MEAN of its units' centroids. Decoded through `PostcodeBinaryResolver.toAnchorLookup()` this
 *   reproduces the training lookup's GB entries exactly — posterior `{GB: 1}` (GB keys cannot collide:
 *   unit keys are ≥5 chars and letter-initial, outward keys ≤4 and letter-initial, NL keys are
 *   digit-initial, every numeric system's keys are digits only), unit centroids verbatim, outward
 *   centroids the same mean — up to the format's i16 centroid quantization (~300 m).
 *
 *   Usage: node packages/mailwoman/dev-tools/build-gb-anchor-bin.run.ts --out <dir>
 */

import { dataRootPath } from "@mailwoman/core/utils"
import { serializePostcodeBinary, type PostcodeBinaryEntry } from "@mailwoman/neural/postcode-binary-resolver"
import { writeFileSync } from "@mailwoman/platform/fs"
import { join } from "@mailwoman/platform/path"
import { DatabaseSync } from "@mailwoman/platform/sqlite"
import { parseArgs } from "@mailwoman/platform/util"

/**
 * A GB unit postcode in the space-stripped key form the train painter writes. Verbatim from
 * `mailwoman/gazetteer-pipeline/anchor-lookup.ts`.
 */
const GB_UNIT_KEY = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/

/**
 * A GB unit's inward code is ALWAYS the last three characters; the outward district is the rest.
 */
const GB_INWARD_LENGTH = 3

const { values } = parseArgs({
	options: {
		out: { type: "string" },
		shard: { type: "string", default: "postalcode-gb-codepoint.db" },
	},
})

if (!values.out) throw new Error("--out <dir> is required")

const shardPath = values.shard!.startsWith("/") ? values.shard! : String(dataRootPath("wof", values.shard!))
const con = new DatabaseSync(shardPath, { readOnly: true })

const rows = con
	.prepare("SELECT name, latitude, longitude FROM spr WHERE placetype='postalcode' AND is_current!=0")
	.all() as Array<{ name: string; latitude: number; longitude: number }>

con.close()

const entries: PostcodeBinaryEntry[] = []
const outward = new Map<string, { lat: number; lon: number; n: number }>()
let skipped = 0

for (const row of rows) {
	const pc = (row.name || "").trim().toUpperCase()

	if (!GB_UNIT_KEY.test(pc)) {
		skipped++

		continue
	}

	const lat = Number(row.latitude)
	const lon = Number(row.longitude)

	entries.push({ postcode: pc, country: "GB", lat, lon })

	// The outward mean is over PLACED units only — `addGBOutwardKeys` skips `source === null` rows,
	// which is exactly the unplaced ones.
	if (lat === 0 && lon === 0) continue
	const district = pc.slice(0, -GB_INWARD_LENGTH)
	const bucket = outward.get(district)

	if (bucket) {
		bucket.lat += lat
		bucket.lon += lon

		bucket.n++
	} else {
		outward.set(district, { lat, lon, n: 1 })
	}
}

for (const [district, { lat, lon, n }] of outward) {
	entries.push({ postcode: district, country: "GB", lat: lat / n, lon: lon / n })
}

const bytes = serializePostcodeBinary(entries)
const outPath = join(values.out, "postcode-gb.bin")
writeFileSync(outPath, bytes)

console.log(
	`GB: ${entries.length.toLocaleString()} keys ` +
		`(${(entries.length - outward.size).toLocaleString()} units + ${outward.size.toLocaleString()} outward districts, ` +
		`${skipped.toLocaleString()} rows skipped as non-unit-shaped) → ${outPath} ` +
		`(${(bytes.length / 1024 / 1024).toFixed(2)} MB)`
)
