/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Batched bulk-write transactions — the `COMMIT`/`BEGIN` cadence every streaming ingest repeats around its
 *   raw prepared-statement loop.
 */

/**
 * One open batched transaction over a connection.
 */
export interface BatchedTransaction {
	/**
	 * Record one written row. Every `rowsPerCommit` rows the open transaction is committed and a new one opened; answers
	 * `true` on the call that committed, so a caller can hang a progress report off the boundary.
	 */
	rowWritten(): boolean
	/**
	 * Commit the open transaction — the ordinary end of an ingest loop.
	 */
	commit(): void
	/**
	 * Best-effort `ROLLBACK`, and it must never replace the real error: a build runs with the journal off (nothing is
	 * ever published without the swap), so SQLite may refuse to unwind. What matters is that the caller sees WHY the
	 * ingest stopped, not that a scratch file was tidied.
	 */
	rollbackQuietly(): void
}

/**
 * Open a transaction that commits and reopens itself every `rowsPerCommit` written rows.
 *
 * The batch size is the caller's: a geometry table whose rows carry a blob wants a smaller transaction than a
 * fixed-width staging table, because a larger one grows the write-ahead file without improving throughput.
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
