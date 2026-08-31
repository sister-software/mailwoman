/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Sql.js `exec` results as row objects.
 */

export interface ExecResult {
	columns: string[]
	values: unknown[][]
}

/**
 * The first result set of a Sql.js `exec` call as one object per row, keyed by column name. No result set answers `[]`.
 */
export function rowsFromExec<Row = Record<string, unknown>>(res: ExecResult[] | undefined): Row[] {
	const first = res?.[0]

	if (!first) return []

	const { columns, values } = first

	return values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])) as Row)
}

/**
 * The minimal async-exec handle the probes below need — the shape `loadHTTPVFSDatabase` resolves to.
 */
export interface SQLExecutor {
	db: { exec(sql: string): Promise<ExecResult[]> }
}

/**
 * One round trip to confirm the database carries a table — graceful on a tableless shard.
 */
export function tableExists(worker: SQLExecutor, name: string): Promise<boolean> {
	return worker.db
		.exec(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='${name.replaceAll("'", "''")}'`)
		.then((res) => Number(rowsFromExec(res)[0]?.n ?? 0) > 0)
}

/**
 * Memoize a zero-argument async probe as its in-flight promise so concurrent callers share one round trip; a rejection
 * clears the memo so a transient failure can retry.
 */
export function memoizeResettable<T>(fn: () => Promise<T>): () => Promise<T> {
	let memo: Promise<T> | undefined

	return () => {
		if (!memo) {
			memo = fn()

			memo.catch(() => {
				memo = undefined
			})
		}

		return memo
	}
}
