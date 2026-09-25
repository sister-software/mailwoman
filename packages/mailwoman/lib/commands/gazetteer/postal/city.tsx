/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { allRows } from "@mailwoman/core/utils"
import type { PostalCityCandidateDatabase } from "@mailwoman/resolver-wof-sqlite"
import { Box, Text } from "ink"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Command specification for `gazetteer postal-city`, which adds the `postal_city_candidate`
 * table to a candidate database so that the resolver can map a postal city
 * and postcode to the geographic locality.
 *
 * The command modifies the candidate database in place and drops and recreates the table on each run.
 */
export const spec = {
	name: "postal-city",
	description: "Add the postal-city side index to a candidate database",
	options: {
		"candidate-db": { type: "string", required: true, description: "Candidate DB to modify in place" },
		"alias-db": { type: "string", description: "Postal-city alias DB" },
		"postcode-locality-db": { type: "string", description: "Postcode-to-locality DB" },
	},
} as const satisfies CommandSpec

const GazetteerPostalCity: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { DatabaseClient } = await import("@mailwoman/sqlite/client")
		const { wofDatabasePath } = await import("@mailwoman/resolver-wof-sqlite/paths")

		const candidateDB = options.candidateDB

		const aliasDB = options.aliasDB ?? wofDatabasePath("postal-city-alias-us.db")
		const postcodeLocalityDB = options.postcodeLocalityDB ?? wofDatabasePath("postcode-locality-us.db")

		const { createPostalCityCandidateTable, POSTAL_CITY_CANDIDATE_COLUMNS, POSTAL_CITY_CANDIDATE_TABLE } =
			await import("@mailwoman/resolver-wof-sqlite")

		const { normalizeLocalityForKey } = await import("@mailwoman/resolver-wof-sqlite/street")

		using db = new DatabaseClient<PostalCityCandidateDatabase>(candidateDB)

		console.error(`▸ loading postcode → locality from ${postcodeLocalityDB}`)

		using pcl = new DatabaseClient<PostalCityCandidateDatabase>(postcodeLocalityDB, { readOnly: true })
		const pcToLocality = new Map<string, number>()

		for (const r of allRows<{ postcode: string; locality_id: number }>(
			pcl.prepare("SELECT postcode, locality_id FROM postcode_locality WHERE is_containing = 1")
		)) {
			// Most postcodes have one containing locality, so the first row wins.
			if (!pcToLocality.has(String(r.postcode))) {
				pcToLocality.set(String(r.postcode), Number(r.locality_id))
			}
		}

		// The candidate table supplies each locality's name and coordinates, so no admin-DB join is needed.
		console.error(`▸ loading candidate coordinates from ${candidateDB}`)

		const sprToPlace = new Map<number, { name: string; lat: number; lon: number }>()

		for (const r of allRows<{ spr_id: number; name: string | null; lat: number; lon: number }>(
			db.prepare("SELECT spr_id, name, latitude AS lat, longitude AS lon FROM candidate WHERE latitude IS NOT NULL")
		)) {
			if (!sprToPlace.has(Number(r.spr_id))) {
				sprToPlace.set(Number(r.spr_id), { name: String(r.name ?? ""), lat: Number(r.lat), lon: Number(r.lon) })
			}
		}

		console.error(`▸ loading divergent postal-city edges from ${aliasDB}`)

		using alias = new DatabaseClient<PostalCityCandidateDatabase>(aliasDB, { readOnly: true })

		const edges = allRows<{ postcode: string; postal_city: string }>(
			alias.prepare("SELECT postcode, postal_city FROM postal_city_alias WHERE divergent = 1")
		)

		// Schema changes use the Kysely builder, while the insert loop uses a prepared
		// statement on the same connection for speed.
		await db.schema.dropTable(POSTAL_CITY_CANDIDATE_TABLE).ifExists().execute()
		await createPostalCityCandidateTable(db)

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
		await db.schema.createIndex("idx_pcc_spr").ifNotExists().on(POSTAL_CITY_CANDIDATE_TABLE).column("spr_id").execute()

		const summary = [
			`postal_city_candidate built → ${candidateDB}`,
			`${inserted.toLocaleString()} edges inserted`,
			`${noLocality.toLocaleString()} skipped — postcode has no containing locality in the postcode_locality database`,
			`${noCoord.toLocaleString()} skipped — locality not in candidate table`,
		]

		return summary
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null
}

export default GazetteerPostalCity
