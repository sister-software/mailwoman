import { readFileSync } from "node:fs"

// Counts the `wof-admin` and `wof-postalcode` train rows by country. It also counts the rows whose country the
// stage-1 `country_weights` leaves out. `FileRows` skips those rows (mtf-sampler/src/file_rows.rs).
//
// Usage: node --env-file=/home/lab/Projects/mailwoman/.env scratchpad/2026/11/27/count-v8170-stage1-countries.ts
import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"
import { parse } from "yaml"

import { loadTrainingConfig } from "../../../../packages/mailwoman/tools/training/config.ts"
import { samplerConfigJSON } from "../../../../packages/mailwoman/tools/training/sampler.ts"

const dataRoot = process.env.MAILWOMAN_DATA_ROOT

if (!dataRoot) {
	throw new Error("MAILWOMAN_DATA_ROOT is unset")
}

const dir = "packages/corpus/data/training-configs"
const config = await loadTrainingConfig(`${dir}/v8.16.0-base-c6-wofreps-positions-v0822-s42.yaml`)
const stage1 = parse(readFileSync(`${dir}/v8.17.0-stage1-gazetteer-v0822-s42.yaml`, "utf8")) as {
	data: { country_weights: Record<string, number> }
}
const weights = process.env.COUNT_BASE_WEIGHTS ? config.data.country_weights : stage1.data.country_weights
const mtf = await mtfNode()
const corpusDir = config.data.corpus_dir.replace(/^\/data\//, `${dataRoot}/`)
const reader = new mtf.SplitColumns(samplerConfigJSON(config, { corpusDir }), "train", ["source", "country"], {
	column: "source",
	values: ["WOF-ADMIN", "WOF-POSTALCODE"],
})
const bySource = new Map<string, { rows: number; dropped: Map<string, number> }>()

for (let chunk = reader.nextChunk(); chunk; chunk = reader.nextChunk()) {
	const source = chunk.strings["source"] ?? []
	const country = chunk.strings["country"] ?? []

	for (let i = 0; i < chunk.rows; i++) {
		const s = source[i] ?? "(null)"
		const c = country[i] ?? null
		let entry = bySource.get(s)

		if (!entry) {
			entry = { rows: 0, dropped: new Map() }
			bySource.set(s, entry)
		}

		entry.rows++

		if (c == null || !((weights[c] ?? 0) > 0)) {
			const key = c ?? "(null)"
			entry.dropped.set(key, (entry.dropped.get(key) ?? 0) + 1)
		}
	}
}

for (const [source, { rows, dropped }] of bySource) {
	const total = [...dropped.values()].reduce((a, b) => a + b, 0)
	console.log(`${source}: ${rows} train rows, ${rows - total} admitted, ${total} dropped`, Object.fromEntries(dropped))
}
