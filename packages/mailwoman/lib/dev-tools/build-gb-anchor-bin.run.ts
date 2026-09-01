/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the GB postcode-anchor binary (`postcode-gb.bin`, PCB1) that the anchor-v2 retrain's serving
 *   half needs — UNIT keys plus OUTWARD district keys, in the SPACE-STRIPPED UPPERCASE form the train
 *   painter writes (`SW1A 2AA` → `SW1A2AA`).
 *
 *   WHY THIS EXISTS RATHER THAN `mailwoman gazetteer postcode-binary --locale GB:<database>`. That
 *   command's GB branch (`aggregateGbOutward`) derives the outward code by splitting `name` on a
 *   SPACE, because it was written against `postalcode-gb.db` (the retired GeoNames-lineage database),
 *   whose `name` column carries the spaced display form. The licence-clean Code-Point Open database
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
 *   Usage: node packages/mailwoman/lib/dev-tools/build-gb-anchor-bin.run.ts --out <dir>
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { dataRootPath } from "@mailwoman/core/utils"
import { serializePostcodeBinary } from "@mailwoman/neural/postcode-binary-resolver"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { join } from "path-ts"

import { buildPostcodeBinaryEntries } from "#gazetteer-pipeline/postcode/binary"

const { values } = parseArguments({
	options: {
		out: { type: "string" },
		database: { type: "string", default: "postalcode-gb-codepoint.db" },
	},
})

if (!values.out) throw new Error("--out <dir> is required")

const databasePath = values.database!.startsWith("/") ? values.database! : String(dataRootPath("wof", values.database!))
using con = new DatabaseClient<WOFDatabase>(databasePath, { readOnly: true })

const rows = con
	.prepare("SELECT name, latitude AS lat, longitude AS lon FROM spr WHERE placetype='postalcode' AND is_current!=0")
	.all() as Array<{ name: string; lat: number; lon: number }>

const { entries, skipped, outwardKeys } = buildPostcodeBinaryEntries("GB", rows, { gbGranularity: "unit" })

const bytes = serializePostcodeBinary(entries)
const outPath = join(values.out, "postcode-gb.bin")
await writeLocalFile(bytes, outPath)

console.log(
	`GB: ${entries.length.toLocaleString()} keys ` +
		`(${(entries.length - outwardKeys).toLocaleString()} units + ${outwardKeys.toLocaleString()} outward districts, ` +
		`${skipped.toLocaleString()} rows skipped as non-unit-shaped) → ${outPath} ` +
		`(${ByteFormatter.formatIEC(bytes.length)})`
)
