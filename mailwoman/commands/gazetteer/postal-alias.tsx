/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer postal-alias` — build the POSTAL-CITY ALIAS table (#475) from the
 *   pinned-release Overture US Parquet: per-address ground truth for the
 *   postal-city/geographic-city split that the resolver's coordinate-first soft-scorer currently
 *   approximates geometrically.
 *
 *   The signal: 45.9M US rows carry BOTH `postal_city` (what the postal system calls the place — USPS
 *   "acceptable city names", vanity cities) AND a geographic locality (`address_levels[2]`); 16.0M
 *   of them (34.9%) DIVERGE. Aggregated per `(postcode, postal_city, geo_locality)` with observed
 *   counts, that divergence is the alias evidence: "postcode 10954's mail says Nanuet; the polygon
 *   says Clarkstown".
 *
 *   SIBLING table by design (`postal_city_alias`, its own sqlite) — never mixed into the PIP-derived
 *   `postcode_locality` rows: one table = one provenance class (feedback-no-load-bearing-trivia). A
 *   count floor drops typo noise; everything kept is observed-in-the-wild N times, with N
 *   recorded.
 *
 *   Writes the output DB DIRECTLY (deletes any prior file, then builds in place) — same behavior as
 *   the original `scripts/build-postal-city-alias.ts`. Progress streams to stderr; the final
 *   summary is on stdout. @duckdb/node-api is an OPTIONAL peer, imported dynamically inside the
 *   build.
 */

import { mkdirSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { dataRootPath } from "@mailwoman/core/utils"
import type { PostalCityAliasDatabase } from "@mailwoman/resolver-wof-sqlite"
import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	release: zod
		.string()
		.default("2026-05-20.0")
		.describe("Pinned Overture release dir under <data-root>/overture/<release>/addresses-us.parquet"),
	minCount: zod.coerce
		.number()
		.int()
		.positive()
		.default(25)
		.describe("Drop (postcode, postal_city, geo_locality) aggregates observed fewer than this many times"),
	out: zod.string().optional().describe("Output DB path. Default <data-root>/wof/postal-city-alias-us.db"),
})

export { OptionsSchema as options }

const GazetteerPostalAlias: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [summary, setSummary] = useState<string[]>()

	useEffect(() => {
		void (async () => {
			try {
				const out = options.out ?? dataRootPath("wof", "postal-city-alias-us.db")
				const parquet = dataRootPath("overture", options.release, "addresses-us.parquet")
				const minCount = options.minCount

				mkdirSync(dirname(out), { recursive: true })
				rmSync(out, { force: true })

				// @duckdb/node-api is an OPTIONAL peer dep — import it dynamically so merely loading this
				// command (e.g. `mailwoman --help`, which eagerly imports every command) doesn't fault when
				// the peer isn't installed.
				const { DuckDBInstance } = await import("@duckdb/node-api")

				console.error(`▸ aggregating ${parquet} (min-count ${minCount})`)
				const instance = await DuckDBInstance.create()
				const duck = await instance.connect()
				const result = await duck.runAndReadAll(`
					SELECT
						trim(postcode) AS postcode,
						lower(trim(postal_city)) AS postal_city,
						lower(trim(address_levels[2].value)) AS geo_locality,
						count(*)::BIGINT AS n
					FROM read_parquet('${parquet}')
					WHERE nullif(trim(postcode), '') IS NOT NULL
						AND nullif(trim(postal_city), '') IS NOT NULL
						AND nullif(trim(address_levels[2].value), '') IS NOT NULL
					GROUP BY 1, 2, 3
					HAVING count(*) >= ${minCount}
				`)
				const rows = result.getRowObjects() as {
					postcode: string
					postal_city: string
					geo_locality: string
					n: bigint
				}[]

				console.error(`▸ writing ${rows.length.toLocaleString()} rows → ${out}`)
				const db = new DatabaseSync(out)
				db.exec("PRAGMA journal_mode = WAL;")
				// DDL via the SHARED createPostalCityAliasTable builder — the exact table the reader + tests
				// use, so this producer can't drift from postal-city-alias-schema.ts. DuckDB above is the raw
				// parquet reader; the hot INSERT below stays on the raw `db` handle.
				const { createPostalCityAliasTable } = await import("@mailwoman/resolver-wof-sqlite/postal-city-alias-schema")
				const kdb = new DatabaseClient<PostalCityAliasDatabase>({ database: db })
				await createPostalCityAliasTable(kdb)
				const insert = db.prepare(
					"INSERT INTO postal_city_alias (postcode, postal_city, geo_locality, n, divergent, source, release) VALUES (?, ?, ?, ?, ?, ?, ?)"
				)
				db.exec("BEGIN")
				let divergent = 0

				for (const r of rows) {
					const isDivergent = r.postal_city !== r.geo_locality ? 1 : 0
					divergent += isDivergent
					insert.run(
						r.postcode,
						r.postal_city,
						r.geo_locality,
						Number(r.n),
						isDivergent,
						"overture:US",
						String(options.release)
					)
				}
				db.exec("COMMIT")
				// Indexes were created by createPostalCityAliasTable above; just checkpoint + compact.
				db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
				await kdb.destroy()

				setSummary([
					`postal-city alias: ${out}`,
					`${rows.length.toLocaleString()} (postcode, postal_city, geo_locality) pairs (n >= ${minCount})`,
					`divergent pairs: ${divergent.toLocaleString()} (${((100 * divergent) / Math.max(1, rows.length)).toFixed(1)}%)`,
				])
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
		})()
	}, [options])

	useEffect(() => {
		if (summary || error) {
			setImmediate(() => process.exit(error ? 1 : 0))
		}
	}, [summary, error])

	if (error) return <Text color="red">✗ {error}</Text>

	if (summary) {
		return (
			<Box flexDirection="column">
				{summary.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null // progress streams to stderr until the summary lands
}

export default GazetteerPostalAlias
