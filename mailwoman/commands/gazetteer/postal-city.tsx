/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer postal-city` — build the POSTAL-CITY CANDIDATE side-index (#741 / #475) INTO
 *   a candidate gazetteer so the candidate-backend resolver (the demo/CLI default) can resolve a
 *   user-typed postal city to its geographic locality. Adds one table,
 *   `postal_city_candidate(name_key, postcode → spr_id, …)`, keyed exactly by `(name_key,
 *   postcode)`.
 *
 *   Bridge (no admin-DB join): for each DIVERGENT `(postcode, postal_city)` in the alias DB, the
 *   `postcode_locality` shard gives the postcode's CONTAINING `locality_id`; that locality's
 *   coordinate and name come straight from the candidate table's own row for that `spr_id`. So a
 *   postal-city query with the postcode resolves to exactly the geographic locality the FTS
 *   coordinate-first path would pick — but via one exact probe, no population/region ranking.
 *
 *   Idempotent: drops + recreates the table each run. Modifies the candidate DB IN PLACE — run it on
 *   a COPY to validate, then fold it into the canonical candidate build before republish. Progress
 *   streams to stderr; the final summary is on stdout.
 */

import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { dataRootPath } from "@mailwoman/core/utils"
import type { PostalCityCandidateDatabase } from "@mailwoman/resolver-wof-sqlite"
import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../../sdk/cli.ts"

const OptionsSchema = zod.object({
	candidateDb: zod.string().describe("Candidate DB to add the side-index to (MODIFIED IN PLACE — run on a copy first)"),
	aliasDB: zod.string().optional().describe("Postal-city alias DB. Default <data-root>/wof/postal-city-alias-us.db"),
	postcodeLocalityDB: zod
		.string()
		.optional()
		.describe("Postcode→locality shard DB. Default <data-root>/wof/postcode-locality-us.db"),
})

export { OptionsSchema as options }

const GazetteerPostalCity: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [summary, setSummary] = useState<string[]>()

	useEffect(() => {
		void (async () => {
			try {
				const candidateDb = options.candidateDb

				if (!candidateDb) {
					throw new Error("--candidate-db is required (modified in place — run on a copy first)")
				}
				const aliasDB = options.aliasDB ?? dataRootPath("wof", "postal-city-alias-us.db")
				const postcodeLocalityDB = options.postcodeLocalityDB ?? dataRootPath("wof", "postcode-locality-us.db")

				const { createPostalCityCandidateTable, POSTAL_CITY_CANDIDATE_COLUMNS, POSTAL_CITY_CANDIDATE_TABLE } =
					await import("@mailwoman/resolver-wof-sqlite")
				const { normalizeLocalityForKey } = await import("@mailwoman/resolver-wof-sqlite/street-normalize")

				const db = new DatabaseSync(candidateDb)

				// postcode → containing locality_id (the geo-locality the postcode sits in).
				console.error(`▸ loading postcode → locality from ${postcodeLocalityDB}`)
				const pcl = new DatabaseSync(postcodeLocalityDB, { readOnly: true })
				const pcToLocality = new Map<string, number>()

				for (const r of pcl
					.prepare("SELECT postcode, locality_id FROM postcode_locality WHERE is_containing = 1")
					.all() as unknown as Array<{ postcode: string; locality_id: number }>) {
					// First containing locality per postcode wins (postcodes with one containing polygon — the norm).
					if (!pcToLocality.has(String(r.postcode))) {
						pcToLocality.set(String(r.postcode), Number(r.locality_id))
					}
				}
				pcl.close()

				// spr_id → {name, lat, lon} from the candidate table's own rows (the coord bridge).
				console.error(`▸ loading candidate coordinates from ${candidateDb}`)
				const sprToPlace = new Map<number, { name: string; lat: number; lon: number }>()

				for (const r of db
					.prepare("SELECT spr_id, name, latitude AS lat, longitude AS lon FROM candidate WHERE latitude IS NOT NULL")
					.all() as unknown as Array<{ spr_id: number; name: string | null; lat: number; lon: number }>) {
					if (!sprToPlace.has(Number(r.spr_id))) {
						sprToPlace.set(Number(r.spr_id), { name: String(r.name ?? ""), lat: Number(r.lat), lon: Number(r.lon) })
					}
				}

				// Divergent postal-city edges.
				console.error(`▸ loading divergent postal-city edges from ${aliasDB}`)
				const alias = new DatabaseSync(aliasDB, { readOnly: true })
				const edges = alias
					.prepare("SELECT postcode, postal_city FROM postal_city_alias WHERE divergent = 1")
					.all() as unknown as Array<{ postcode: string; postal_city: string }>
				alias.close()

				// DDL via the Kysely schema-builder (the house idiom); the hot INSERT loop below stays on the
				// raw `node:sqlite` handle for speed. `kdb` wraps `db` — the two share the one connection.
				const kdb = new DatabaseClient<PostalCityCandidateDatabase>({ database: db })
				await kdb.schema.dropTable(POSTAL_CITY_CANDIDATE_TABLE).ifExists().execute()
				await createPostalCityCandidateTable(kdb)
				const insert = db.prepare(
					`INSERT OR IGNORE INTO ${POSTAL_CITY_CANDIDATE_TABLE} (${POSTAL_CITY_CANDIDATE_COLUMNS.join(", ")})
					 VALUES (${POSTAL_CITY_CANDIDATE_COLUMNS.map(() => "?").join(", ")})`
				)

				let inserted = 0
				let noLocality = 0
				let noCoord = 0
				db.exec("BEGIN")

				for (const e of edges) {
					const localityID = pcToLocality.get(String(e.postcode))

					if (localityID === undefined) {
						noLocality++
						continue
					}
					const place = sprToPlace.get(localityID)

					if (!place) {
						noCoord++
						continue
					}
					const key = normalizeLocalityForKey(e.postal_city)

					if (!key) continue
					insert.run(key, String(e.postcode), localityID, place.name, place.lat, place.lon)
					inserted++
				}
				db.exec("COMMIT")
				await kdb.schema
					.createIndex("idx_pcc_spr")
					.ifNotExists()
					.on(POSTAL_CITY_CANDIDATE_TABLE)
					.column("spr_id")
					.execute()
				await kdb.destroy() // closes the underlying `db` handle

				setSummary([
					`postal_city_candidate built → ${candidateDb}`,
					`${inserted.toLocaleString()} edges inserted`,
					`${noLocality.toLocaleString()} skipped — postcode has no containing locality in the postcode_locality shard`,
					`${noCoord.toLocaleString()} skipped — locality not in candidate table`,
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

export default GazetteerPostalCity
