/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Implements `mailwoman gazetteer conventions`, which compiles the authored convention profiles in
 *   `data/conventions/conventions.json` into a read-only SQLite asset.
 *
 *   The asset holds an `address_convention` table keyed by WOF polygon ID and a `meta` table. The
 *   resolver reads it with one indexed lookup per ID.
 *
 *   Each authored entry has the shape `{ "wof_id": number, "source": string, "convention": Convention }`.
 *   The build rejects a row without `source` provenance or with an unregistered strategy, so these
 *   errors surface at build time instead of at runtime.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { CommandError } from "@mailwoman/core/scripting/command"
// `@mailwoman/resolver-wof-sqlite` is an optional peer dependency.
// Runtime values from its root module are imported inside the command,
// so loading the command list works without it.
import type { Convention } from "@mailwoman/resolver-wof-sqlite"
import {
	createAddressConventionTable,
	createConventionMetaTable,
	type ConventionDatabase,
} from "@mailwoman/resolver-wof-sqlite/convention/schema"
import { Box, Text } from "ink"
import { resolvePath } from "path-ts"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * The command specification for `mailwoman gazetteer conventions`.
 */
export const spec = {
	name: "conventions",
	description: "Compile authored convention profiles",
	options: {
		src: { type: "string", default: "data/conventions/conventions.json", description: "Authored convention profiles" },
		out: { type: "string", description: "Compiled SQLite path", deprecatedName: "output" },
	},
} as const satisfies CommandSpec

interface AuthoredConvention {
	wof_id: number
	source: string
	convention: Convention
}

const WEIGHT_KEYS = new Set(["pc", "name", "pop"])

/**
 * Validates the authored rows and throws a {@link CommandError} that lists every problem.
 */
function validate(rows: AuthoredConvention[], known: Set<string>): void {
	const errors: string[] = []
	const seen = new Set<number>()

	for (const [i, r] of rows.entries()) {
		const at = `entry ${i} (wof_id=${r?.wof_id})`

		if (typeof r?.wof_id !== "number") {
			errors.push(`${at}: wof_id must be a number`)
		} else if (seen.has(r.wof_id)) {
			errors.push(`${at}: duplicate wof_id`)
		} else {
			seen.add(r.wof_id)
		}

		if (typeof r?.source !== "string" || !r.source.trim()) {
			errors.push(`${at}: every row needs non-empty 'source' provenance`)
		}

		const c = r?.convention

		if (!c || typeof c !== "object") {
			errors.push(`${at}: missing convention object`)

			continue
		}

		for (const s of c.candidateStrategies ?? [])
			if (!known.has(s)) {
				errors.push(`${at}: names unknown strategy "${s}" (known: ${[...known].join(", ")})`)
			}

		for (const k of Object.keys(c.scoringWeights ?? {}))
			if (!WEIGHT_KEYS.has(k)) {
				errors.push(`${at}: unknown scoringWeights key "${k}"`)
			}
	}

	if (errors.length) throw new CommandError(`convention validation failed:\n  - ${errors.join("\n  - ")}`)
}

/**
 * Compiles the convention profiles and renders a summary.
 */
const GazetteerConventions: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { DatabaseClient } = await import("@mailwoman/sqlite/client")
		const { wofDatabasePath } = await import("@mailwoman/resolver-wof-sqlite/paths")
		const { assertDatabaseIntegrity } = await import("@mailwoman/sqlite/sealed-db")

		const { BUILTIN_STRATEGY_NAMES } = await import("@mailwoman/resolver-wof-sqlite")
		const KNOWN = new Set<string>(BUILTIN_STRATEGY_NAMES)

		const src = options.src
		const output = resolvePath(options.out ?? wofDatabasePath("conventions.db"))

		const rows = await readLocalJSONFile<AuthoredConvention[]>(src)

		if (!Array.isArray(rows)) throw new CommandError(`${src} must be a JSON array of authored conventions`)
		validate(rows, KNOWN)

		const kdb = new DatabaseClient<ConventionDatabase>(output)
		await kdb.schema.dropTable("address_convention").ifExists().execute()
		await kdb.schema.dropTable("meta").ifExists().execute()

		await createAddressConventionTable(kdb)

		const ins = kdb.prepare("INSERT INTO address_convention (wof_id, convention, source) VALUES (?, ?, ?)")

		for (const r of rows) {
			ins.run(r.wof_id, stringifyJSON(r.convention), r.source)
		}

		await createConventionMetaTable(kdb)

		const meta: Record<string, string> = {
			name: "mailwoman-conventions",
			description: "Geographic Rule Engine convention profiles, keyed by WOF polygon id (Direction E)",
			schema_version: "1",
			source:
				"Authored profiles compiled from data/conventions/conventions.json (built from source rather than a prebuilt dump)",
			rows: String(rows.length),
			strategies_known: [...KNOWN].join(","),
		}

		const insMeta = kdb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")

		for (const [k, v] of Object.entries(meta)) {
			insMeta.run(k, v)
		}

		// Rollback journaling leaves no WAL sidecar files, so the database file is self-contained.
		kdb.exec("PRAGMA journal_mode = DELETE")
		kdb.exec("ANALYZE")
		assertDatabaseIntegrity(kdb, output)
		kdb.exec("VACUUM")
		await kdb.destroy()

		const summary = [`conventions: ${output}`, `${rows.length} convention(s) compiled, integrity=ok`]

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

export default GazetteerConventions
