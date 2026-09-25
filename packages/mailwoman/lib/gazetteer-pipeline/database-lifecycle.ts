/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { removePath } from "@mailwoman/core/fs/writers"
import { tryParsingJSON } from "@mailwoman/core/json"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { assertDatabaseIntegrity } from "@mailwoman/sqlite/sealed-db"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { buildFTS, type BuildFTSResult } from "#gazetteer-pipeline/fts"

/**
 * The staging-database pragma block the ingest-then-`vacuum into` builders open with.
 */
export function applyStagingPragmas<DB>(db: DatabaseClient<DB>): void {
	db.exec(`
			PRAGMA page_size = 8192;
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			PRAGMA busy_timeout = 30000;
			PRAGMA temp_store = MEMORY;
			PRAGMA cache_size = -200000;
		`)
}

/**
 * Removes a staging database and its WAL and SHM sidecars.
 *
 * Call it before a build as well as after publishing, because a stale staging
 * file would be reopened as a half-ingested database.
 */
export async function removeStagingArtifacts(ingestPath: string): Promise<void> {
	for (const stale of [ingestPath, `${ingestPath}-wal`, `${ingestPath}-shm`]) {
		if (await pathExists(stale)) {
			await removePath(stale)
		}
	}
}

/**
 * Checkpoints the staging database's WAL, switches it to a sidecar-free journal mode, and runs `ANALYZE`.
 *
 * Call it after the last write and before {@link vacuumDatabaseInto}.
 */
export function freezeStagingDatabase<DB>(db: DatabaseClient<DB>): void {
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
	db.exec("PRAGMA journal_mode = DELETE")
	db.exec("ANALYZE")
}

/**
 * Publishes the staging database to `out` with `VACUUM INTO`, first removing any
 * existing file there because `VACUUM INTO` refuses to overwrite.
 */
export async function vacuumDatabaseInto<DB>(db: DatabaseClient<DB>, out: string): Promise<void> {
	if (await pathExists(out)) {
		await removePath(out)
	}

	db.prepare("VACUUM INTO ?").run(out)
}

/**
 * Opens a published database, builds its full-text search and bounding-box indexes, and closes it.
 */
export async function buildDatabaseFTS<DB>(
	out: string,
	openDatabase: (path: string) => DatabaseClient<DB>,
	onProgress?: (phase: string, detail?: string) => void
): Promise<BuildFTSResult> {
	using outDB = openDatabase(out)

	return await buildFTS(outDB, { onProgress })
}

/**
 * Finishes a database built in place rather than staged, by switching to a sidecar-free
 * journal mode, analyzing, checking integrity, and vacuuming.
 * The caller seals the database afterwards.
 */
export function finalizeSealedBuild<DB>(db: DatabaseClient<DB>, path: string): void {
	db.exec("PRAGMA journal_mode = DELETE")
	db.exec("ANALYZE")
	assertDatabaseIntegrity(db, path)

	db.exec("VACUUM")
}

/**
 * Marks a provenance field that a rebuild could not recover.
 *
 * It is a sentinel rather than an empty string so that a consumer can tell "unknown" from "no value exists".
 */
export const UNKNOWN_PROVENANCE = "unknown (offline rebuild, no acquisition.json)"

/**
 * Reads the `acquisition.json` sidecar that an acquisition step wrote beside its download,
 * returning `null` when it is missing or unparseable.
 */
export async function readAcquisitionSidecar<Sidecar>(sourceDir: PathBuilderLike): Promise<Sidecar | null> {
	const raw = await readLocalTextFile(PathBuilder.from(sourceDir)("acquisition.json")).catch(() => null)

	return raw ? tryParsingJSON<Sidecar>(raw) : null
}
