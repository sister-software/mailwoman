/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer inspect fst [--db …] [--show-continuations] [--max N] <query…>` — build the
 *   FST from an admin gazetteer and probe queries (path, accepting interpretations by importance,
 *   optional continuations). Ported from the scripts drawer (PR E, #1029); the resolver module is
 *   lazy-imported (optional peer).
 */

import { join } from "node:path"

import { Text } from "ink"
import { commandError, type CommandComponent, useCommandTask } from "mailwoman/cli-kit"
import zod from "zod"

const ArgumentsSchema = zod.array(zod.string().describe("Queries to probe"))
export { ArgumentsSchema as args }

const OptionsSchema = zod.object({
	db: zod.string().optional().describe("Admin gazetteer DB. Default the live admin-global-priority.db"),
	showContinuations: zod.boolean().default(false).describe("Print prefix continuations"),
	max: zod.string().optional().describe("Max interpretations shown per query (default 10)"),
})

export { OptionsSchema as options }

const GazetteerInspectFST: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ args, options }) => {
	const state = useCommandTask(async () => {
		const { wofDir } = await import("mailwoman/gazetteer-pipeline")

		if (!args.length) throw commandError("pass at least one query")
		const dbPath = options.db ?? join(wofDir(), "admin-global-priority.db")
		const maxResults = Number.parseInt(options.max ?? "10", 10)
		const { buildFSTFromWOF } = await import("@mailwoman/resolver-wof-sqlite/fst-builder")

		console.error(`Building FST from ${dbPath}...`)

		const start = performance.now()

		const { matcher, result } = buildFSTFromWOF({
			dbPath,
			countries: ["US"],
			placetypes: ["country", "region", "county", "locality"],
			languages: ["eng", ""],
		})

		console.error(
			`Built: ${result.stateCount} states, ${result.placeCount} places, ${result.edgeCount} edges (${((performance.now() - start) / 1000).toFixed(1)}s)\n`
		)

		for (const query of args) {
			const q = matcher.query(query)

			console.log(`"${query}" → path: [${q.path.map((t) => `"${t}"`).join(", ")}]`)
			console.log(`  State: ${q.stateID}, Accepting: ${q.accepting.length} interpretations`)

			if (q.accepting.length) {
				const sorted = [...q.accepting].toSorted((a, b) => b.referential - a.referential)

				console.log(`  Top by referential likelihood:`)

				for (const p of sorted.slice(0, maxResults)) {
					const ref = p.referential > 0 ? ` ref ${p.referential.toFixed(4)}` : ""
					// Printed only when the artifact carries one — an absent article must not read as 0.00.
					const enc = p.encyclopedic === undefined ? "" : ` enc ${p.encyclopedic.toFixed(4)}`
					const chain = p.parentChain.length ? ` chain=[${p.parentChain.join("→")}]` : ""

					console.log(`    ${p.placetype.padEnd(12)} ${p.name.padEnd(20)}${ref}${enc}${chain}  wof:${p.wofID}`)
				}

				if (sorted.length > maxResults) {
					console.log(`    ... and ${sorted.length - maxResults} more`)
				}
			}

			if (options.showContinuations && q.continuations.length) {
				const shown = q.continuations.toSorted((a, b) => b.acceptingCount - a.acceptingCount).slice(0, 15)

				console.log(`  Continuations (${q.continuations.length} total):`)

				for (const c of shown) {
					console.log(`    "${c.token}"${c.acceptingCount > 0 ? ` → ${c.acceptingCount} places` : ""}`)
				}
			}

			console.log()
		}
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	return null
}

export default GazetteerInspectFST
