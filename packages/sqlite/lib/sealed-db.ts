/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The sealed-artifact invariant: every SQLite DB a build produces is a READ-ONLY asset. `sealDatabase`
 *   is the last step of every builder — checkpoint, freeze the journal, chmod 0444. `openBuiltClient`
 *   (`@mailwoman/sqlite/sealed`) is how anything opens a data artifact; a write-mode open of a sealed
 *   file throws a NAMED error pointing at the rebuild command instead of a cryptic SQLITE_READONLY. Unsealing is deliberate and
 *   manual (`chmod u+w`), never programmatic — rebuild, don't mutate.
 *
 *   `swapDatabaseIntoPlace` is the other half of that invariant — the atomic publish step AGENTS.md
 *   specifies in prose ("build it successfully, then move the previous version to a temp directory,
 *   and then move the new version into place"). It lives here because this module already owns the
 *   built-artifact lifecycle, and because a rule the project states in prose and implements more than
 *   once in code should be a function.
 */

import type { DatabaseSync } from "node:sqlite"

import { pathExists, statPath } from "@mailwoman/core/fs/readers"
import { changeMode, movePath, removePath, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { basename } from "path-ts"

/**
 * The one capability {@link assertDatabaseIntegrity} needs. Narrowing to it rather than naming a handle type lets a
 * `DatabaseClient` satisfy the parameter with no import and no cast.
 */
type IntegrityProbe = Pick<DatabaseSync, "prepare">

/**
 * `node:sqlite` via {@link process.getBuiltinModule} — invisible to bundlers. A static import here would ride the
 * `@mailwoman/core/utils` barrel into every consumer, and the docs' plugin loader (which transpiles `docusaurus.config`
 * imports) can't resolve `node:sqlite` (CI: "Cannot find module 'sqlite'"). The builtin accessor keeps `node:sqlite`
 * out of the static import graph with zero resolve surface.
 */
function sqlite(): typeof import("node:sqlite") {
	return process.getBuiltinModule("node:sqlite")
}

/**
 * A write-mode open was attempted on a sealed (0444) data artifact.
 */
export class SealedArtifactError extends Error {
	constructor(path: string) {
		super(
			`${basename(path)} is a sealed read-only artifact — rebuild it via \`mailwoman gazetteer build …\`, ` +
				`don't mutate it. (Deliberate unseal: chmod u+w — but prefer a rebuild.)`
		)

		this.name = "SealedArtifactError"
	}
}

/**
 * True when the artifact exists and carries no write bits (the sealed state {@link sealDatabase} leaves).
 */
export async function isSealed(path: string): Promise<boolean> {
	return (await pathExists(path)) && ((await statPath(path)).mode & 0o222) === 0
}

/**
 * Finalize a built DB: WAL-checkpoint → `journal_mode = DELETE` → remove `-wal`/`-shm` sidecars → `chmod 0o444`.
 * Idempotent. Throws if the checkpoint cannot complete (another writer holds the DB).
 */
export async function sealDatabase(path: string): Promise<void> {
	// A previously sealed artifact needs the write bit back for the journal-mode switch.
	if (await isSealed(path)) {
		await changeMode(path, 0o644)
	}

	let mode: { journal_mode: string }

	{
		using db = new (sqlite().DatabaseSync)(path)
		const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number }

		if (checkpoint.busy !== 0) {
			throw new Error(`sealDatabase: WAL checkpoint busy on ${path} — close all writers first`)
		}

		mode = db.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode: string }
	}

	if (mode.journal_mode !== "delete") {
		throw new Error(`sealDatabase: journal_mode switch failed on ${path} (still ${mode.journal_mode})`)
	}

	for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
		if (await pathExists(sidecar)) {
			await removePath(sidecar)
		}
	}

	await changeMode(path, 0o444)
}

/**
 * Verify a freshly-built database is not corrupt, immediately before it is sealed and published.
 *
 * Belongs beside {@link sealDatabase} for the same reason `swapDatabaseIntoPlace` does: the check is part of the
 * built-artifact lifecycle, and every builder was running it from its own copy. `integrity_check` answers with the
 * single row `{ integrity_check: "ok" }` on a healthy file and one row per problem otherwise, so only the first matters
 * — a builder that reads the column and compares it to `"ok"` has done the whole check.
 *
 * @throws When the database reports anything other than `ok`, naming the artifact and what SQLite said.
 */
export function assertDatabaseIntegrity(db: IntegrityProbe, artifact: string): void {
	const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined
	const verdict = row?.integrity_check

	if (verdict !== "ok") {
		throw new Error(`integrity_check failed on ${basename(artifact)}: ${verdict ?? "no result"}`)
	}
}

/**
 * Refuse a write-mode open of a sealed artifact, naming the rebuild command instead of letting SQLite answer
 * `SQLITE_READONLY`.
 *
 * The open itself lives in `@mailwoman/sqlite/sealed` — `openBuiltClient`, which every caller uses. This half stays
 * here because it is a filesystem predicate, and because this module reaches `node:sqlite` through
 * {@link process.getBuiltinModule} to keep the `@mailwoman/core/utils` barrel free of it.
 *
 * @throws {SealedArtifactError} When `path` is sealed.
 */
export async function assertUnsealedForWrite(path: string): Promise<void> {
	if (await isSealed(path)) throw new SealedArtifactError(path)
}

/**
 * Atomically move a freshly-built database into its published location.
 *
 * The build writes to a temp path, so a mid-build crash never leaves a half-written DB at `finalPath`. This moves any
 * prior version aside, slots the new one in, then drops the old — the previous file stays intact until the replacement
 * is committed, and the `-wal`/`-shm` siblings of BOTH paths are cleared so a stale journal can never be paired with a
 * new main file.
 *
 * Sealing (`sealDatabase`) happens on the temp file BEFORE the swap: a sealed artifact is what gets published, and 0444
 * does not prevent a rename.
 */
export async function swapDatabaseIntoPlace(tmpPath: string, finalPath: string): Promise<void> {
	const aside = `${finalPath}.old-${process.pid}`

	if (await pathExists(finalPath)) {
		await movePath(finalPath, aside)
	}

	for (const sfx of ["-wal", "-shm"]) {
		await removePathIfPresent(finalPath + sfx)
	}

	try {
		await movePath(tmpPath, finalPath)
	} catch (error) {
		// The prior version is already aside at this point — a failed forward rename must not leave
		// the slot empty while a restorable artifact sits one rename away.
		if ((await pathExists(aside)) && !(await pathExists(finalPath))) {
			await movePath(aside, finalPath)
		}

		throw error
	}

	for (const sfx of ["-wal", "-shm"]) {
		await removePathIfPresent(tmpPath + sfx)
	}

	await removePathIfPresent(aside)
}
