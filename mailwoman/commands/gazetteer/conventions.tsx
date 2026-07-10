/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer conventions` — build the **convention asset** (#290, Direction E) FROM
 *   SOURCE: compile the authored convention profiles in `data/conventions/conventions.json` into a
 *   read-only, provenance-stamped sqlite asset (`address_convention` keyed by WOF polygon id + a
 *   `meta` row), the same distributable-asset shape as `postcode-locality-intl.db`.
 *
 *   The authored JSON is the human-editable source of truth (diffable, code-reviewed); the `.db` is
 *   the queryable, immutable compiled form the resolver reads ON DEMAND (one indexed lookup per id,
 *   not the whole table paged into memory). Per the provenance-first design value: every row
 *   carries `source` provenance, and a convention that names a strategy this build doesn't register
 *   is rejected HERE, loudly, rather than silently no-opping at runtime.
 *
 *   Authored entry shape (each element of the JSON array): { "wof_id": 85633111, "source": "…why this
 *   row exists…", "convention": { …Convention… } }
 *
 *   The build writes the asset DIRECTLY to `--output` (the original `scripts/build-conventions.ts`
 *   behavior); it then VACUUMs + integrity-checks before returning. Progress is quiet — only the
 *   final summary lands on stdout.
 */

import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { dataRootPath } from "@mailwoman/core/utils"
// resolver-wof-sqlite is an OPTIONAL peer dep of mailwoman; its runtime value `BUILTIN_STRATEGY_NAMES`
// is imported DYNAMICALLY inside the command (the gazetteer-pipeline convention) so merely loading the
// commands (e.g. `mailwoman --help`) doesn't fault when the peer is absent. `Convention` is type-only.
import type { Convention } from "@mailwoman/resolver-wof-sqlite"
import { Box, Text } from "ink"
import zod from "zod"

import { commandError, type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	src: zod
		.string()
		.default("data/conventions/conventions.json")
		.describe("Authored convention profiles — the JSON-array source of truth"),
	output: zod.string().optional().describe("Compiled sqlite asset path. Default <data-root>/wof/conventions.db"),
})

export { OptionsSchema as options }

interface AuthoredConvention {
	wof_id: number
	source: string
	convention: Convention
}

const WEIGHT_KEYS = new Set(["pc", "name", "pop"])

/**
 * Reject malformed or code-incoherent conventions at BUILD time (loud), so the runtime never has to.
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

	if (errors.length) throw commandError(`convention validation failed:\n  - ${errors.join("\n  - ")}`)
}

const GazetteerConventions: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { BUILTIN_STRATEGY_NAMES } = await import("@mailwoman/resolver-wof-sqlite")
		const KNOWN = new Set<string>(BUILTIN_STRATEGY_NAMES)

		const src = options.src
		const output = options.output ?? dataRootPath("wof", "conventions.db")

		const rows = JSON.parse(readFileSync(src, "utf8")) as AuthoredConvention[]

		if (!Array.isArray(rows)) throw commandError(`${src} must be a JSON array of authored conventions`)
		validate(rows, KNOWN)

		const db = new DatabaseSync(output)
		// DDL via the Kysely schema-builder; the row INSERTs below stay on the raw `db` handle.
		const kdb = new DatabaseClient({ database: db })
		await kdb.schema.dropTable("address_convention").ifExists().execute()
		await kdb.schema.dropTable("meta").ifExists().execute()
		await kdb.schema
			.createTable("address_convention")
			// wof_id: the WOF admin polygon this profile attaches to. convention: the Convention JSON.
			// source: provenance — why this row exists / where it came from.
			.addColumn("wof_id", "integer", (c) => c.primaryKey())
			.addColumn("convention", "text", (c) => c.notNull())
			.addColumn("source", "text", (c) => c.notNull())
			.execute()
		const ins = db.prepare("INSERT INTO address_convention (wof_id, convention, source) VALUES (?, ?, ?)")

		for (const r of rows) {
			ins.run(r.wof_id, JSON.stringify(r.convention), r.source)
		}

		// Freeze into the read-only distributable asset — same discipline as our other WOF tables.
		await kdb.schema
			.createTable("meta")
			.addColumn("key", "text", (c) => c.primaryKey())
			.addColumn("value", "text")
			.execute()
		const meta: Record<string, string> = {
			name: "mailwoman-conventions",
			description: "Geographic Rule Engine convention profiles, keyed by WOF polygon id (Direction E)",
			schema_version: "1",
			source:
				"Authored profiles compiled from data/conventions/conventions.json (built from source, not a prebuilt dump)",
			rows: String(rows.length),
			strategies_known: [...KNOWN].join(","),
		}
		const insMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")

		for (const [k, v] of Object.entries(meta)) {
			insMeta.run(k, v)
		}

		db.exec("PRAGMA journal_mode = DELETE") // no -wal/-shm sidecar; the .db is self-contained
		db.exec("ANALYZE")
		const ok = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check

		if (ok !== "ok") throw new Error(`integrity_check failed: ${ok}`)
		db.exec("VACUUM")
		await kdb.destroy() // closes the underlying `db` handle

		const summary = [`conventions: ${output}`, `${rows.length} convention(s) compiled, integrity=ok`]

		return summary
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

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

	return null // the build is quiet until the summary lands
}

export default GazetteerConventions
