// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The sealed-artifact invariant: every SQLite DB a build produces is a read-only asset.
 *
 *   `sealDatabase` is the last step of every builder — checkpoint, freeze the journal, chmod 0444.
 *   `openBuiltClient` (`@mailwoman/sqlite/sealed`) is how anything opens a data
 *   artifact. a write-mode open of a sealed file throws a descriptive error pointing
 *   at the rebuild command instead of a cryptic SQLITE_READONLY.
 *
 *   A caller can restore write permission only with manual `chmod u+w`;
 *   the program never changes permissions.
 *   Rebuild the artifact to make changes.
 *
 *   `swapDatabaseIntoPlace` is the atomic publish step agents.md specifies in prose
 *   ("build it successfully. Move the previous version to a temp directory. Move the new version into place.").
 *   It lives here because this module already owns the built-artifact lifecycle.
 *
 *   A rule stated in project prose and implemented by several builders belongs in a shared function.
 */

import type { DatabaseSync } from "node:sqlite"

import { processExists } from "@mailwoman/core/fs/lock"
import { sortedGlob } from "@mailwoman/core/fs/readers"
import { pathExists, statPath } from "@mailwoman/core/fs/readers/stat"
import { changeMode, movePath, removePath, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { basename, dirname, type PathBuilderLike } from "path-ts"

/**
 * The one capability {@link assertDatabaseIntegrity} needs.
 *
 * A narrow callback type lets a `DatabaseClient` satisfy the parameter with no import and no cast.
 */
type IntegrityProbe = Pick<DatabaseSync, "prepare">

/**
 * `node:sqlite` via {@link process.getBuiltinModule} — invisible to bundlers.
 *
 * A static import here would ride the `@mailwoman/core/utils` barrel into every consumer.
 * The docs' plugin loader transpiles `docusaurus.config` imports and cannot resolve
 * `node:sqlite` (CI: "Cannot find module 'sqlite'").
 *
 * The builtin accessor keeps `node:sqlite` out of the static import graph with zero resolve surface.
 */
function sqlite(): typeof import("node:sqlite") {
	return process.getBuiltinModule("node:sqlite")
}

/**
 * A write-mode open was attempted on a sealed (0444) data artifact.
 */
export class SealedArtifactError extends Error {
	constructor(path: PathBuilderLike) {
		super(
			`${basename(path)} is a sealed read-only artifact — rebuild it via \`mailwoman gazetteer build …\`, ` +
				`don't mutate it. (Deliberate unseal: chmod u+w — but prefer a rebuild.)`
		)

		this.name = "SealedArtifactError"
	}
}

/**
 * True when the artifact exists and has no write bits (the sealed state {@link sealDatabase} leaves).
 */
export async function isSealed(path: PathBuilderLike): Promise<boolean> {
	return (await pathExists(path)) && ((await statPath(path)).mode & 0o222) === 0
}

/**
 * Finalize a built DB: WAL-checkpoint → `journal_mode = delete` → remove
 * `-wal`/`-shm` sidecars → `chmod 0o444`.
 *
 * Idempotent.
 * Throws if the checkpoint cannot complete (another writer holds the DB).
 */
export async function sealDatabase(path: PathBuilderLike): Promise<void> {
	// A previously sealed artifact needs the write bit back for the journal-mode switch.
	if (await isSealed(path)) {
		await changeMode(path, 0o644)
	}

	let mode: { journal_mode: string }

	{
		using db = new (sqlite().DatabaseSync)(path.toString())
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
 * Verify a freshly-built database isn't corrupt, immediately before it is sealed and published.
 *
 * Belongs beside {@link sealDatabase} for the same reason `swapDatabaseIntoPlace` does.
 * The check is part of the built-artifact lifecycle.
 *
 * Every builder previously ran its own copy.
 * `integrity_check` answers with the single row `{ integrity_check: "ok" }` on a healthy file
 * and one row per problem otherwise, so only the first matters.
 *
 * A builder that reads the column and compares it to `"ok"` has done the whole check.
 *
 * @throws When the database reports anything other than `ok`, naming the artifact and what SQLite said.
 */
export function assertDatabaseIntegrity(db: IntegrityProbe, artifact: PathBuilderLike): void {
	const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined
	const verdict = row?.integrity_check

	if (verdict !== "ok") {
		throw new Error(`integrity_check failed on ${basename(artifact)}: ${verdict ?? "no result"}`)
	}
}

/**
 * Refuse a write-mode open of a sealed artifact, naming the rebuild command
 * instead of letting SQLite answer `SQLITE_READONLY`.
 *
 * The open itself lives in `@mailwoman/sqlite/sealed`.
 * `openBuiltClient`, which every caller uses.
 *
 * This half stays here because it is a filesystem predicate.
 * This module reaches `node:sqlite` through {@link process.getBuiltinModule} to
 * keep the `@mailwoman/core/utils` barrel free of it.
 *
 * @throws {SealedArtifactError} When `path` is sealed.
 */
export async function assertUnsealedForWrite(path: PathBuilderLike): Promise<void> {
	if (await isSealed(path)) throw new SealedArtifactError(path)
}

/**
 * Atomically move a freshly-built database into its published location.
 *
 * The build writes to a temp path, so a mid-build crash never leaves a half-written DB at `finalPath`.
 * This moves any prior version aside, slots the new one in, then drops the old.
 *
 * The previous file stays intact until the replacement is committed.
 * The function clears the `-wal` and `-shm` siblings of both paths, so a stale
 * journal cannot pair with a new main file.
 *
 * The code seals (`sealDatabase`) the temp file before the swap.
 * The published artifact is sealed.
 * Mode 0444 still permits a rename.
 */
export async function swapDatabaseIntoPlace(tmpPath: PathBuilderLike, finalPath: PathBuilderLike): Promise<void> {
	const tmpPathString = tmpPath.toString()
	const finalPathString = finalPath.toString()
	const aside = `${finalPathString}.old-${process.pid}`

	if (await pathExists(finalPathString)) {
		await movePath(finalPathString, aside)
	}

	for (const sfx of ["-wal", "-shm"]) {
		await removePathIfPresent(finalPathString + sfx)
	}

	try {
		await movePath(tmpPathString, finalPathString)
	} catch (error) {
		// The prior version is already aside at this point.
		// A failed forward rename mustn't leave the slot empty while a restorable artifact sits one rename away.
		if ((await pathExists(aside)) && !(await pathExists(finalPathString))) {
			await movePath(aside, finalPathString)
		}

		throw error
	}

	for (const sfx of ["-wal", "-shm"]) {
		await removePathIfPresent(tmpPathString + sfx)
	}

	await removePathIfPresent(aside)
	await recoverInterruptedBuilds(finalPath)
}

/**
 * The suffixes a writer gives the two siblings of a published path, each followed by `-<pid>`.
 */
export interface BuildSiblingSuffixes {
	/**
	 * The sibling a writer fills before the swap, such as `tmp` or `staging`.
	 */
	building: string
	/**
	 * The sibling the swap moves the published version to, such as `old` or `replaced`.
	 */
	setAside: string
}

const SEALED_BUILD_SUFFIXES: BuildSiblingSuffixes = { building: "tmp", setAside: "old" }

/**
 * Restores or removes what an interrupted write of `finalPath` left beside it.
 *
 * A sealed build writes `<final>.tmp-<pid>` and, during its swap, moves the
 * published file to `<final>.old-<pid>`.
 * A process killed in between leaves those files on disk under a pid no later build shares.
 *
 * Another writer that follows the same pattern under other names passes its `suffixes`.
 * A sibling may be a file or a directory, and a file's `-wal` and `-shm` sidecars count with it.
 *
 * When the published slot is empty, the newest set-aside sibling of an exited process
 * is the last published version, and it moves back into the slot.
 * Every other sibling of an exited process is removed.
 *
 * A sibling whose process still runs belongs to a write in progress and stays.
 */
export async function recoverInterruptedBuilds(
	finalPath: PathBuilderLike,
	suffixes: BuildSiblingSuffixes = SEALED_BUILD_SUFFIXES
): Promise<void> {
	const finalPathString = finalPath.toString()
	const directory = dirname(finalPathString).toString()

	if (!(await pathExists(directory))) return

	const name = basename(finalPathString).toString()

	const siblingPattern = new RegExp(
		`\\.(${RegExp.escape(suffixes.building)}|${RegExp.escape(suffixes.setAside)})-(\\d+)(-wal|-shm)?$`,
		"u"
	)

	const siblings = [
		...(await sortedGlob(directory, `${name}.${suffixes.building}-*`, { onlyFiles: false })),
		...(await sortedGlob(directory, `${name}.${suffixes.setAside}-*`, { onlyFiles: false })),
	].flatMap((path) => {
		const match = siblingPattern.exec(path)

		return match && !processExists(Number(match[2])) ? [{ path, kind: match[1], sidecar: match[3] ?? null }] : []
	})

	if (!(await pathExists(finalPathString))) {
		const stranded = siblings.filter((sibling) => sibling.kind === suffixes.setAside && !sibling.sidecar)

		const newest = (
			await Promise.all(
				stranded.map(async (sibling) => ({ ...sibling, mtimeMs: (await statPath(sibling.path)).mtimeMs }))
			)
		).toSorted((a, b) => b.mtimeMs - a.mtimeMs)[0]

		if (newest) {
			await movePath(newest.path, finalPathString)
		}
	}

	for (const sibling of siblings) {
		await removePathIfPresent(sibling.path)
	}
}
