/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Batched bulk-write transactions — the `commit`/`begin` cadence every streaming ingest repeats around its
 *   raw prepared-statement loop.
 */

/**
 * One open batched transaction over a connection.
 */
export interface BatchedTransaction {
/**
 * Record one written row, committing and reopening the transaction every `rowsPerCommit` rows and
 * answering `true` on the call that committed.
 */
	rowWritten(): boolean
	commit(): void
/**
 * Best-effort `rollback` that must never replace the real error, so the caller still sees why the
 * ingest stopped.
 */
	rollbackQuietly(): void
}

/**
 * Open a transaction that commits and reopens itself every `rowsPerCommit` written rows, with the
 * batch size left to the caller.
 */
export function beginBatched(
	database: { exec(sql: string): void },
	options: { rowsPerCommit: number }
): BatchedTransaction {
	let pending = 0

	database.exec("BEGIN")

	return {
		rowWritten() {
			pending++

			if (pending < options.rowsPerCommit) return false

			database.exec("COMMIT")
			database.exec("BEGIN")

			pending = 0

			return true
		},
		commit() {
			database.exec("COMMIT")
		},
		rollbackQuietly() {
			try {
				database.exec("ROLLBACK")
			} catch {
				// The temp artifact is discarded either way.
			}
		},
	}
}
