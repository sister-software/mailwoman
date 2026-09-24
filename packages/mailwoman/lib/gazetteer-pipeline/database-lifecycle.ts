/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared lifecycle helpers for sealed gazetteer builds: staging, publishing, FTS,
 *   finalization, and acquisition provenance. Keep staging pragmas byte-identical.
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
 * Remove a staging database and its WAL/SHM sidecars.
 *
 * Run before a build (a stale partial staging file would be reopened as a half-ingested database)
 * and after the `vacuum into` publish (the staging tree is scratch, and the sidecars
 * would otherwise outlive the file they belong to).
 */
export async function removeStagingArtifacts(ingestPath: string): Promise<void> {
	for (const stale of [ingestPath, `${ingestPath}-wal`, `${ingestPath}-shm`]) {
		if (await pathExists(stale)) {
			await removePath(stale)
		}
	}
}

/**
 * Freeze the staging database: checkpoint the WAL away, drop back to a sidecar-free
 * journal mode, and give the query planner its statistics.
 *
 * Run after the last write and before {@link vacuumDatabaseInto}.
 */
export function freezeStagingDatabase<DB>(db: DatabaseClient<DB>): void {
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
	db.exec("PRAGMA journal_mode = DELETE")
	db.exec("ANALYZE")
}

/**
 * Publish the frozen staging database to `out` via `vacuum into`, replacing any
 * previous artifact at that path first.
 * `vacuum into` refuses to overwrite.
 */
export async function vacuumDatabaseInto<DB>(db: DatabaseClient<DB>, out: string): Promise<void> {
	if (await pathExists(out)) {
		await removePath(out)
	}

	db.prepare("VACUUM INTO ?").run(out)
}

/**
 * The FTS pass over a freshly published (not yet sealed) database: open it,
 * build `place_search` + `place_bbox`, close it.
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
 * The close ceremony for a builder that writes its output database IN place (no staging + `vacuum into`):
 * drop to a sidecar-free journal mode, analyze, check integrity, compact.
 *
 * The caller seals afterwards.
 */
export function finalizeSealedBuild<DB>(db: DatabaseClient<DB>, path: string): void {
	db.exec("PRAGMA journal_mode = DELETE")
	db.exec("ANALYZE")
	assertDatabaseIntegrity(db, path)

	db.exec("VACUUM")
}

/**
 * What a database records when a rebuild cannot recover a provenance field.
 *
 * A sentinel string rather than an empty one: a consumer reading `source_release: ""`
 * cannot tell "no release label exists" from "nobody looked", and the meaning-of-zero
 * rule says those are different claims.
 */
export const UNKNOWN_PROVENANCE = "unknown (offline rebuild, no acquisition.json)"

/**
 * Recover the `acquisition.json` sidecar an acquisition step wrote beside its download.
 *
 * Absent is not fatal — the caller substitutes {@link UNKNOWN_PROVENANCE} and says so in the database.
 */
export async function readAcquisitionSidecar<Sidecar>(sourceDir: PathBuilderLike): Promise<Sidecar | null> {
	const raw = await readLocalTextFile(PathBuilder.from(sourceDir)("acquisition.json")).catch(() => null)

	return raw ? tryParsingJSON<Sidecar>(raw) : null
}
