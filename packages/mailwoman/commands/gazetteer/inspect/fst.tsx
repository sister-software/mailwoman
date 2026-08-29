/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer inspect fst [--db …] [--show-continuations] [--max N] <query…>` — build the
 *   FST from an admin gazetteer and probe queries (path, accepting interpretations by importance,
 *   optional continuations).
 */

import { join } from "@mailwoman/platform/path"
import { Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "fst",
	description: "Probe an admin-gazetteer FST.",
	positionals: [{ name: "query", required: true, multiple: true, description: "Queries to probe" }],
	options: {
		db: { type: "string", description: "Admin gazetteer DB" },
		"show-continuations": { type: "boolean", default: false, description: "Print prefix continuations" },
		max: { type: "number", default: 10, description: "Max interpretations per query" },
	},
} as const satisfies CommandSpec

interface Options {
	db?: string
	showContinuations: boolean
	max: number
}

const GazetteerInspectFST: ParsedCommandComponent<Options> = ({ args, options }) => {
	const state = useCommandTask(async () => {
		const { wofDir } = await import("#gazetteer-pipeline")

		const dbPath = options.db ?? join(wofDir(), "admin-global-priority.db")
		const maxResults = options.max
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
