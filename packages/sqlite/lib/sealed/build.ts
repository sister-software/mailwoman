/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import type { PathBuilderLike } from "path-ts"

import { DatabaseClient } from "#client"
import { sealDatabase, swapDatabaseIntoPlace } from "#sealed/db"

export interface BuildSealedArtifactOptions<DB, Streamed, Result> {
	/**
	 * Where the sealed artifact lands.
	 */
	out: PathBuilderLike
	/**
	 * Create every table the build writes, including any build-only scratch table the finish phase drops.
	 */
	createTables: (database: DatabaseClient<DB>) => Promise<void>
	/**
	 * The in-process ingest, run under the first handle.
	 *
	 * Return `null` to defer to {@link batched}, keeping any writes made before deferring.
	 */
	ingest: (database: DatabaseClient<DB>) => Promise<Streamed | null>
	/**
	 * The bounded child-process ingest, run while the parent holds no handle: each child opens the
	 * temp file and appends one chunk at a time, so there is exactly one writer at every instant.
	 */
	batched?: (tmpPath: string) => Promise<Streamed>
	/**
	 * Post-ingest work under the second handle: assertions over what was streamed,
	 * index/coverage/manifest writes, dropping any scratch table.
	 *
	 * The artifact's on-disk size is measurable only after this returns and the swap lands.
	 */
	finish: (database: DatabaseClient<DB>, streamed: Streamed) => Promise<Result>
}

/**
 * Run one sealed-artifact build.
 */
export async function buildSealedArtifact<DB, Streamed, Result>(
	options: BuildSealedArtifactOptions<DB, Streamed, Result>
): Promise<Result> {
	const tmpPath = `${options.out}.tmp-${process.pid}`

	let streamed: Streamed | null

	{
		using kdb = new DatabaseClient<DB>(tmpPath)

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

	if (streamed == null) {
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

		const result = await options.finish(kdb, streamed as Streamed)

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
