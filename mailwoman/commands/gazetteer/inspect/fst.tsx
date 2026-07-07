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
import { useEffect, useState } from "react"
import zod from "zod"

import { wofDir } from "../../../gazetteer-pipeline/index.js"
import type { CommandComponent } from "../../../sdk/cli.js"

const ArgumentsSchema = zod.array(zod.string().describe("Queries to probe"))
export { ArgumentsSchema as args }

const OptionsSchema = zod.object({
	db: zod.string().optional().describe("Admin gazetteer DB. Default the live admin-global-priority.db"),
	showContinuations: zod.boolean().default(false).describe("Print prefix continuations"),
	max: zod.string().optional().describe("Max interpretations shown per query (default 10)"),
})

export { OptionsSchema as options }

const GazetteerInspectFST: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ args, options }) => {
	const [error, setError] = useState<string>()
	const [done, setDone] = useState(false)

	useEffect(() => {
		void (async () => {
			try {
				if (args.length === 0) throw new Error("pass at least one query")
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

					if (q.accepting.length > 0) {
						const sorted = [...q.accepting].sort((a, b) => b.importance - a.importance)
						console.log(`  Top by importance:`)

						for (const p of sorted.slice(0, maxResults)) {
							const imp = p.importance > 0 ? ` imp ${p.importance.toFixed(4)}` : ""
							const chain = p.parentChain.length > 0 ? ` chain=[${p.parentChain.join("→")}]` : ""
							console.log(`    ${p.placetype.padEnd(12)} ${p.name.padEnd(20)}${imp}${chain}  wof:${p.wofID}`)
						}

						if (sorted.length > maxResults) {
							console.log(`    ... and ${sorted.length - maxResults} more`)
						}
					}

					if (options.showContinuations && q.continuations.length > 0) {
						const shown = q.continuations.sort((a, b) => b.acceptingCount - a.acceptingCount).slice(0, 15)
						console.log(`  Continuations (${q.continuations.length} total):`)

						for (const c of shown) {
							console.log(`    "${c.token}"${c.acceptingCount > 0 ? ` → ${c.acceptingCount} places` : ""}`)
						}
					}
					console.log()
				}
				setDone(true)
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
		})()
	}, [args, options])

	useEffect(() => {
		if (done || error) {
			setImmediate(() => process.exit(error ? 1 : 0))
		}
	}, [done, error])

	if (error) return <Text color="red">✗ {error}</Text>

	return null
}

export default GazetteerInspectFST
