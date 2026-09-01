/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The sealed polygon-artifact build sequence: one temp file beside the destination, two handles, every
 *   cleanup path, then `VACUUM` → seal → atomic swap.
 *
 *   THE INGEST AND THE FINISH PHASES USE SEPARATE HANDLES, ALWAYS — including the in-process path, which does
 *   not need them separated. The batched path DOES: its children open the same file, so the parent's handle
 *   has to be closed across them, and a single shared handle silently becomes a closed one by the time the
 *   finish phase runs. Doing it one way in both paths is what puts the fixture suites on the same sequence a
 *   national build takes.
 */

import { removePathIfPresent } from "@mailwoman/core/fs/writers"

import { DatabaseClient } from "#client"
import { sealDatabase, swapDatabaseIntoPlace } from "#sealed-db"

export interface BuildSealedArtifactOptions<DB, Streamed, Result> {
	/**
	 * Where the sealed artifact lands. The build writes beside it and swaps.
	 */
	out: string
	/**
	 * Create every table the build writes — the layer's own, the contract's, and any build-only scratch table (which the
	 * finish phase drops before the artifact is sealed).
	 */
	createTables: (database: DatabaseClient<DB>) => Promise<void>
	/**
	 * The in-process ingest, run under the FIRST handle. Return `undefined` to defer to {@link batched}; any writes made
	 * before deferring (attribute preloads) are kept.
	 */
	ingest: (database: DatabaseClient<DB>) => Promise<Streamed | undefined>
	/**
	 * The bounded child-process ingest, run while the parent holds NO handle. Each child opens the temp file and appends;
	 * chunks run one at a time, so there is exactly one writer at every instant.
	 */
	batched?: (tmpPath: string) => Promise<Streamed>
	/**
	 * Post-ingest work under the SECOND handle: assertions over what was streamed, index/coverage/manifest writes,
	 * dropping any scratch table. `VACUUM`, the seal and the swap follow; the artifact's on-disk size is measurable only
	 * after this returns and the swap lands.
	 */
	finish: (database: DatabaseClient<DB>, streamed: Streamed) => Promise<Result>
}

/**
 * Run one sealed-artifact build.
 *
 * Every failure path removes the temp file: a failed build otherwise leaves a partial multi-gigabyte file whose name
 * carries this process's pid, so nothing would ever pick it up again — the difference between a retry loop that fails
 * and one that fills a disk.
 */
export async function buildSealedArtifact<DB, Streamed, Result>(
	options: BuildSealedArtifactOptions<DB, Streamed, Result>
): Promise<Result> {
	const tmpPath = `${options.out}.tmp-${process.pid}`

	let streamed: Streamed | undefined

	{
		await using kdb = new DatabaseClient<DB>(tmpPath)

		try {
			kdb.exec("PRAGMA journal_mode = OFF")
			kdb.exec("PRAGMA synchronous = OFF")

			await options.createTables(kdb)

			streamed = await options.ingest(kdb)
		} catch (error) {
			await kdb.destroy().catch(() => undefined)
			await removePathIfPresent(tmpPath)

			throw error
		}
	}

	if (streamed === undefined) {
		if (!options.batched) {
			throw new Error("buildSealedArtifact: the in-process ingest deferred and no batched ingest was supplied")
		}

		try {
			streamed = await options.batched(tmpPath)
		} catch (error) {
			await removePathIfPresent(tmpPath)

			throw error
		}
	}

	const kdb = new DatabaseClient<DB>(tmpPath)

	try {
		kdb.exec("PRAGMA journal_mode = OFF")
		kdb.exec("PRAGMA synchronous = OFF")

		const result = await options.finish(kdb, streamed)

		kdb.exec("VACUUM")

		await kdb.destroy()

		await sealDatabase(tmpPath)
		await swapDatabaseIntoPlace(tmpPath, options.out)

		return result
	} catch (error) {
		await kdb.destroy().catch(() => undefined)
		await removePathIfPresent(tmpPath)

		throw error
	}
}
