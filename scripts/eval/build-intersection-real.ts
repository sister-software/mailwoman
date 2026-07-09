/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the REAL intersection eval (#487) from TIGER EDGES: a node where two road edges with
 *   distinct FULLNAMEs meet is a real crossing — name pair + node coordinate, rendered in the
 *   observed query forms the synth shard under-covers (the night-10 format audit: `corner of`,
 *   unpadded `X/Y`, `intersection of`, bare-tail).
 *
 *   Recipe per the #487 issue comment. Counties span regimes: Cook IL (grid city), Morris NJ
 *   (suburb), Washington VT (rural — same county as the #476 ground truth). Gold carries
 *   intersection_a/b + region (state); locality is deliberately ABSENT (a county's nodes span many
 *   localities and a wrong gold poisons the eval — honesty over completeness).
 *
 *   Inputs: TIGER EDGES shapefiles, downloaded per county to --edges-dir:
 *   https://www2.census.gov/geo/tiger/TIGER2023/EDGES/tl_2023_<fips>_edges.zip (unzipped) Read via
 *   DuckDB spatial ST_Read — no shapefile dependency.
 *
 *   Usage: node scripts/eval/build-intersection-real.ts\
 *   [--edges-dir /tmp/tiger-edges] [--per-county 6] [--seed 42]\
 *   [--out data/eval/external/intersection-real.jsonl]
 */

import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { DuckDBInstance } from "@duckdb/node-api"

const COUNTIES = [
	{ fips: "17031", state: "IL", regime: "grid-city" },
	{ fips: "34027", state: "NJ", regime: "suburb" },
	{ fips: "50023", state: "VT", regime: "rural" },
] as const

/** The render forms, spanning the synth shard's covered set AND the audited gaps. */
const FORMS: ReadonlyArray<{ id: string; render: (a: string, b: string, st: string) => string }> = [
	{ id: "amp-tail", render: (a, b, st) => `${a} & ${b}, ${st}` },
	{ id: "and-bare", render: (a, b) => `${a} and ${b}` },
	{ id: "at-tail", render: (a, b, st) => `${a} at ${b}, ${st}` },
	{ id: "corner-of", render: (a, b) => `corner of ${a} and ${b}` },
	{ id: "intersection-of", render: (a, b, st) => `intersection of ${a} and ${b}, ${st}` },
	{ id: "slash-unpadded", render: (a, b) => `${a}/${b}` },
	{ id: "at-sign-bare", render: (a, b) => `${a} @ ${b}` },
]

const { values: args } = parseArgs({
	options: {
		"edges-dir": { type: "string", default: "/tmp/tiger-edges" },
		"per-county": { type: "string", default: "6" },
		seed: { type: "string", default: "42" },
		out: { type: "string", default: "data/eval/external/intersection-real.jsonl" },
	},
})
const PER_COUNTY = Number(args["per-county"])

const instance = await DuckDBInstance.create()
const db = await instance.connect()
await db.run("INSTALL spatial; LOAD spatial;")

interface Crossing {
	a: string
	b: string
	lat: number
	lon: number
	node: number
	fips: string
	state: string
}

const crossings: Crossing[] = []

for (const county of COUNTIES) {
	const shp = `${args["edges-dir"]}/tl_2023_${county.fips}_edges.shp`
	// Every (node, name) incidence: an edge touches its from-node at the line start and its
	// to-node at the line end. A node with >= 2 distinct road names is a crossing.
	const result = await db.runAndReadAll(`
		WITH incidence AS (
			SELECT TNIDF AS node, FULLNAME AS name, ST_StartPoint(geom) AS pt
			FROM ST_Read('${shp}') WHERE MTFCC LIKE 'S1%' AND FULLNAME IS NOT NULL
			UNION ALL
			SELECT TNIDT AS node, FULLNAME AS name, ST_EndPoint(geom) AS pt
			FROM ST_Read('${shp}') WHERE MTFCC LIKE 'S1%' AND FULLNAME IS NOT NULL
		),
		nodes AS (
			SELECT node,
				list_sort(list_distinct(list(name))) AS names,
				any_value(pt) AS pt
			FROM incidence GROUP BY node
			HAVING len(list_distinct(list(name))) = 2
		)
		SELECT node, names[1] AS a, names[2] AS b, ST_Y(pt) AS lat, ST_X(pt) AS lon,
			hash(node::VARCHAR || '${args.seed}') AS h
		FROM nodes
		WHERE len(names[1]) >= 6 AND len(names[2]) >= 6  -- skip ramps/letters; keep real street names
		ORDER BY h LIMIT ${PER_COUNTY}
	`)

	for (const r of result.getRowObjects() as Record<string, unknown>[]) {
		crossings.push({
			a: String(r.a),
			b: String(r.b),
			lat: Number(r.lat),
			lon: Number(r.lon),
			node: Number(r.node),
			fips: county.fips,
			state: county.state,
		})
	}
}

// Two deterministic forms per crossing, cycling so every form appears across the set.
const lines: string[] = []
const formCounts = new Map<string, number>()
crossings.forEach((c, i) => {
	for (const offset of [0, 1]) {
		const form = FORMS[(i * 2 + offset) % FORMS.length]!
		const input = form.render(c.a, c.b, c.state)
		const expected: Record<string, string> = { intersection_a: c.a, intersection_b: c.b }

		if (input.includes(`, ${c.state}`)) {
			expected.region = c.state
		}
		lines.push(
			JSON.stringify({
				raw: input,
				components: expected,
				form: form.id,
				source: `tiger:2023:${c.fips}`,
				node: c.node,
				lat: c.lat,
				lon: c.lon,
			})
		)
		formCounts.set(form.id, (formCounts.get(form.id) ?? 0) + 1)
	}
})

writeFileSync(args.out!, lines.join("\n") + "\n")
writeFileSync(
	args.out!.replace(/\.jsonl$/, ".report.json"),
	JSON.stringify(
		{
			rows: lines.length,
			crossings: crossings.length,
			per_county: Object.fromEntries(COUNTIES.map((c) => [c.fips, crossings.filter((x) => x.fips === c.fips).length])),
			forms: Object.fromEntries(formCounts),
			seed: args.seed,
			source: "TIGER2023 EDGES via DuckDB ST_Read; node = >=2 distinct S1* FULLNAMEs",
		},
		null,
		"\t"
	)
)
console.log(`${lines.length} rows from ${crossings.length} crossings → ${args.out}`)
console.log("forms:", Object.fromEntries(formCounts))
