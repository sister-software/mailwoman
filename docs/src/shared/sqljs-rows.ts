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
