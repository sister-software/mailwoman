/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the US SOURCE-INDEPENDENT holdout (#472, re-scoped) from Overture rows whose
 *   provenance chain contains NO OpenAddresses-derived dataset — in practice the DoT NAD
 *   slice (85.5M of 126.5M US rows in release 2026-05-20.0).
 *
 *   Why this exists: the existing US honest holdout (VT/WY/ND) is GEOGRAPHY-independent but
 *   LINEAGE-shared — the eval rows flow through the same OpenAddresses snapshot the corpus
 *   trains on. This holdout is the orthogonal axis: rows our training lineage has never
 *   carried, measuring memorization rather than geographic generalization.
 *
 *   Provenance rules (epic #470): reads the pinned-release local Parquet (never the planet),
 *   keeps the source dataset per row, emits the standard eval-JSONL shape
 *   ({input, lat, lon, expected, state, source}) consumed by oa-resolver-eval/honest-eval.
 *
 *   Usage:
 *     node --experimental-strip-types scripts/eval/build-nad-holdout.ts \
 *       [--release 2026-05-20.0] [--per-state 150] [--seed 42] \
 *       [--out data/eval/external/overture-us-nad-holdout.jsonl]
 */

import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { DuckDBInstance } from "@duckdb/node-api"

const { values: args } = parseArgs({
	options: {
		release: { type: "string", default: "2026-05-20.0" },
		"per-state": { type: "string", default: "150" },
		seed: { type: "string", default: "42" },
		out: { type: "string", default: "data/eval/external/overture-us-nad-holdout.jsonl" },
	},
})

const PARQUET = `/mnt/playpen/mailwoman-data/overture/${args.release}/addresses-us.parquet`
const PER_STATE = Number(args["per-state"])

const instance = await DuckDBInstance.create()
const db = await instance.connect()
// Deterministic sampling: hash-order within state partitions, no RNG (reproducible builds).
const result = await db.runAndReadAll(`
	WITH nad_only AS (
		SELECT
			number, street, postcode, postal_city,
			address_levels[1].value AS state,
			-- NAD's locality field is sometimes a composite "County, Municipality" string (NJ
			-- especially: "Union, Union Township"). The municipality is the LAST comma segment;
			-- grading against the composite fails correct resolves on the county prefix (night-10
			-- finding on #498). Postal_city fallback is never composite.
			coalesce(
				nullif(trim(regexp_extract(address_levels[2].value, '([^,]+)$', 1)), ''),
				nullif(trim(postal_city), '')
			) AS city,
			sources[1].dataset AS dataset,
			lat, lon,
			hash(number || street || postcode || '${args.seed}') AS h
		FROM read_parquet('${PARQUET}')
		WHERE len(list_filter(sources, s -> s.dataset ILIKE '%openaddress%')) = 0
			AND nullif(trim(postcode), '') IS NOT NULL
			AND nullif(trim(street), '') IS NOT NULL
			AND nullif(trim(number), '') IS NOT NULL
			AND nullif(trim(address_levels[1].value), '') IS NOT NULL
	)
	SELECT * FROM (
		SELECT *, row_number() OVER (PARTITION BY state ORDER BY h) AS rn
		FROM nad_only WHERE city IS NOT NULL
	) WHERE rn <= ${PER_STATE}
	ORDER BY state, rn
`)

const rows = result.getRowObjects() as Record<string, unknown>[]
const lines: string[] = []
const datasets = new Map<string, number>()
for (const r of rows) {
	const city = String(r.city)
	const state = String(r.state)
	lines.push(
		JSON.stringify({
			input: `${r.number} ${r.street}, ${city}, ${state} ${r.postcode}`,
			lat: Number(r.lat),
			lon: Number(r.lon),
			expected: { locality: city, region: state, postcode: String(r.postcode) },
			state,
			source: `overture:${r.dataset}`,
		}),
	)
	datasets.set(String(r.dataset), (datasets.get(String(r.dataset)) ?? 0) + 1)
}

writeFileSync(args.out!, lines.join("\n") + "\n")
const states = new Set(rows.map((r) => r.state)).size
writeFileSync(
	args.out!.replace(/\.jsonl$/, ".report.json"),
	JSON.stringify(
		{
			release: args.release,
			rows: lines.length,
			states,
			per_state_cap: PER_STATE,
			seed: args.seed,
			datasets: Object.fromEntries(datasets),
			lineage: "source-independent (zero OpenAddresses-derived datasets in the provenance chain)",
			render_template: "<number> <street>, <city>, <state-abbrev> <postcode>",
			trust: lines.length >= 1000 ? "TRUSTED (>= 1000-row floor)" : "UNTRUSTED (< 1000-row floor)",
		},
		null,
		"\t",
	),
)
console.log(`${lines.length} rows across ${states} states -> ${args.out}`)
console.log("datasets:", Object.fromEntries(datasets))
