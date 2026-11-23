// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `mwdev_sql` runs one caller-supplied statement against a database under the data root.
 *
 * The connection is opened read-only with zero attachable databases, and the read-only
 * open is the guard: a statement that writes fails with SQLite's own error.
 * The error message repeats the statement.
 *
 * Two statements SQLite would run differently than a reader expects are refused before they run.
 * A second statement after the first is refused, because `node:sqlite` would silently drop it.
 *
 * `VACUUM INTO` is refused, because it writes a new file even on a read-only connection.
 *
 * The row cap applies while rows are read, never by rewriting the SQL.
 * Each timed run steps through every row the statement produces, so its duration is the
 * statement's, and the first run also counts the rows the cap left out.
 *
 * This tool executes caller-supplied SQL by design.
 * `packages/sqlite/AGENTS.md` lists it among the SQL that stays raw.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { median } from "@mailwoman/core/math/stats"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { DatabaseClient, type SQLInputValue, type StatementSync } from "@mailwoman/sqlite/client"
import { isAbsolute, relative, resolvePath } from "path-ts"
import { z } from "zod"

import type { DevTool, DevToolDeps } from "#dev-mcp/tool-kit"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 1000
const MAX_RUNS = 25

/**
 * Whether the text after a statement holds only whitespace, semicolons and comments.
 *
 * The scan reads each character once.
 * A regular expression with a lazy block-comment branch inside a repeated group backtracks
 * exponentially in the number of times a tail repeats the closing and opening markers
 * after it opens a block comment, so the tail is scanned by position.
 *
 * A block comment without its closing marker runs to the end of the text, as SQLite reads it.
 */
function isEmptyTail(tail: string): boolean {
	let index = 0

	while (index < tail.length) {
		const character = tail[index]!

		if (character === ";" || character.trim() === "") {
			index++

			continue
		}

		if (tail.startsWith("--", index)) {
			const lineEnd = tail.indexOf("\n", index)

			if (lineEnd === -1) return true

			index = lineEnd + 1

			continue
		}

		if (tail.startsWith("/*", index)) {
			const commentEnd = tail.indexOf("*/", index + 2)

			if (commentEnd === -1) return true

			index = commentEnd + 2

			continue
		}

		return false
	}

	return true
}

const VACUUM_INTO = /^\s*vacuum\b[\s\S]*\binto\b/iu

/**
 * The schema of a database the caller names.
 *
 * The tool reads it only through `prepare`, so it declares no table for the query builder.
 */
type CallerDatabase = Record<string, never>

const SQL_PARAM = z.union([z.string(), z.number(), z.null()])

/**
 * The tool's input.
 */
const SQL_INPUT_SCHEMA = z.object({
	database: z
		.string()
		.min(1)
		.describe(
			"The database file: a path relative to the data root, such as `db/wof/admin-global-priority.db`, or an absolute " +
				"path under it. Any other path is refused."
		),
	sql: z.string().min(1).describe("One SQL statement. A second statement is refused rather than dropped."),
	params: z.array(SQL_PARAM).optional().describe("Positional values for the statement's `?` placeholders."),
	limit: z
		.number()
		.int()
		.positive()
		.max(MAX_LIMIT)
		.default(DEFAULT_LIMIT)
		.describe(`The most rows returned. Default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}.`),
	explain: z.boolean().default(true).describe("Return the `EXPLAIN QUERY PLAN` rows. Default true."),
	runs: z
		.number()
		.int()
		.positive()
		.max(MAX_RUNS)
		.default(1)
		.describe(`Timed runs for the median duration. Default 1, at most ${MAX_RUNS}.`),
})

type SQLInput = z.input<typeof SQL_INPUT_SCHEMA>

/**
 * What one statement returned.
 */
interface SQLResult {
	database: string
	sql: string
	columns: string[]
	rows: Array<Record<string, unknown>>
	rowCount: number
	/**
	 * Whether the statement produced more rows than `limit`.
	 */
	truncated: boolean
	limit: number
	/**
	 * Every row the statement produced, counted on the first run.
	 */
	totalRows: number
	plan: Array<{ id: number; parent: number; detail: string }> | null
	durationsMs: number[]
	medianMs: number | null
	note: string
}

/**
 * Resolve `database` against the data root, refusing a path outside it.
 *
 * The check is on the resolved path.
 * A symbolic link placed under the data root is followed, as every reader of the data root follows one.
 */
function resolveDataRootDatabase(database: string, dataRoot: string): string {
	const resolved = resolvePath(dataRoot, database).toString()
	const inside = relative(dataRoot, resolved)

	if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
		throw new Error(
			`The database ${stringifyJSON(database)} resolves to ${resolved}, which is outside the data root ${dataRoot}; ` +
				"mwdev_sql opens only files under the data root."
		)
	}

	return resolved
}

/**
 * Throws when `sql` holds a statement after the one SQLite prepared.
 */
function assertOneStatement(sql: string, statement: StatementSync): void {
	const first = statement.sourceSQL
	const start = sql.indexOf(first)
	const tail = start === -1 ? "" : sql.slice(start + first.length)

	if (!isEmptyTail(tail)) {
		throw new Error(
			`mwdev_sql runs one statement, and the SQL holds another after ${stringifyJSON(first.trim())}: ${stringifyJSON(tail.trim())}.`
		)
	}
}

/**
 * A value in a form JSON can hold: a blob becomes its length, and an integer past 2^53 its decimal text.
 */
function jsonValue(value: unknown): unknown {
	if (value instanceof Uint8Array) return { blob_bytes: value.byteLength }

	if (typeof value === "bigint") return value.toString()

	return value
}

function jsonRow(row: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonValue(value)]))
}

/**
 * Run one statement and return its capped rows, its plan and its timings.
 *
 * @throws A refusal for a path outside the data root, a missing file, a second statement
 * or `VACUUM INTO`, and SQLite's own error, with the statement, when the statement fails.
 */
async function runReadOnlySQL(raw: SQLInput, dataRoot: string): Promise<SQLResult> {
	const input = SQL_INPUT_SCHEMA.parse(raw)
	const path = resolveDataRootDatabase(input.database, dataRoot)

	if (!(await pathExists(path))) throw new Error(`No database file at ${path}.`)

	if (VACUUM_INTO.test(input.sql)) {
		throw new Error("mwdev_sql refuses VACUUM INTO, because it writes a new file even on a read-only connection.")
	}

	const params = (input.params ?? []) as SQLInputValue[]

	using client = new DatabaseClient<CallerDatabase>(path, { readOnly: true, limits: { attach: 0 } })

	const fail = (error: unknown): never => {
		throw new Error(
			`SQLite refused the statement ${stringifyJSON(input.sql)}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error }
		)
	}

	let statement: StatementSync

	try {
		statement = client.prepare(input.sql)
	} catch (error) {
		return fail(error)
	}

	assertOneStatement(input.sql, statement)

	const columns = statement.columns().map((column) => column.name)
	const rows: Array<Record<string, unknown>> = []
	const durationsMs: number[] = []
	let totalRows = 0

	for (let run = 0; run < input.runs; run++) {
		let count = 0
		const startedAt = performance.now()

		try {
			for (const row of statement.iterate(...params)) {
				if (run === 0 && count < input.limit) {
					rows.push(jsonRow(row as Record<string, unknown>))
				}

				count++
			}
		} catch (error) {
			return fail(error)
		}

		durationsMs.push(performance.now() - startedAt)

		if (run === 0) {
			totalRows = count
		}
	}

	let plan: SQLResult["plan"] = null

	if (input.explain) {
		try {
			plan = (client.prepare(`EXPLAIN QUERY PLAN ${statement.sourceSQL}`).all(...params) as SQLResult["plan"])!.map(
				(row) => ({ id: row.id, parent: row.parent, detail: row.detail })
			)
		} catch (error) {
			return fail(error)
		}
	}

	return {
		database: path,
		sql: input.sql,
		columns,
		rows,
		rowCount: rows.length,
		truncated: totalRows > input.limit,
		limit: input.limit,
		totalRows,
		plan,
		durationsMs,
		medianMs: median(durationsMs),
		note:
			"The statement ran as given: the row cap was applied while reading, and the SQL was not rewritten. Each timed " +
			"run stepped through every row the statement produced, and the plan is EXPLAIN QUERY PLAN over the same statement.",
	}
}

/**
 * The `mwdev_sql` tool.
 *
 * @param options.dataRoot The data root, injected by a test.
 * The default reads `$MAILWOMAN_DATA_ROOT` on each call.
 */
export const sqlTool = (_deps: DevToolDeps, options: { dataRoot?: string } = {}): DevTool => ({
	name: "mwdev_sql",
	description:
		"Run one SQL statement against a database under the data root, opened read-only, and return the column names, " +
		"the rows up to `limit` (with `truncated` and the total row count when more existed), the `EXPLAIN QUERY PLAN` " +
		"rows, and each timed run's duration with their median in milliseconds. A statement that writes fails with " +
		"SQLite's read-only error. Find a database's path through its owning package's `paths` export, such as " +
		"`db/wof/admin-global-priority.db`.",
	inputSchema: SQL_INPUT_SCHEMA,
	handler: async (args) => runReadOnlySQL(args as SQLInput, options.dataRoot ?? dataRootPath().toString()),
})
