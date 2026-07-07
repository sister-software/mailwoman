/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The sealed-artifact invariant: every SQLite DB a build produces is a READ-ONLY asset. `sealDatabase`
 *   is the last step of every builder — checkpoint, freeze the journal, chmod 0444. `openBuiltDatabase`
 *   is how anything opens a data artifact; a write-mode open of a sealed file throws a NAMED error
 *   pointing at the rebuild command instead of a cryptic SQLITE_READONLY. Unsealing is deliberate and
 *   manual (`chmod u+w`), never programmatic — rebuild, don't mutate.
 */
import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs"
import { basename } from "node:path"
import type { DatabaseSync } from "node:sqlite"

/**
 * `node:sqlite` via {@link process.getBuiltinModule} — invisible to bundlers. A static import here would ride the
 * `@mailwoman/core/utils` barrel into every consumer, and the docs' plugin loader (which transpiles `docusaurus.config`
 * imports) can't resolve `node:sqlite` (CI: "Cannot find module 'sqlite'"). The builtin accessor keeps the functions
 * synchronous with zero resolve surface.
 */
function sqlite(): typeof import("node:sqlite") {
	return process.getBuiltinModule("node:sqlite")
}

/** A write-mode open was attempted on a sealed (0444) data artifact. */
export class SealedArtifactError extends Error {
	constructor(path: string) {
		super(
			`${basename(path)} is a sealed read-only artifact — rebuild it via \`mailwoman gazetteer build …\`, ` +
				`don't mutate it. (Deliberate unseal: chmod u+w — but prefer a rebuild.)`
		)
		this.name = "SealedArtifactError"
	}
}

/** True when the artifact exists and carries no write bits (the sealed state {@link sealDatabase} leaves). */
export function isSealed(path: string): boolean {
	return existsSync(path) && (statSync(path).mode & 0o222) === 0
}

/**
 * Finalize a built DB: WAL-checkpoint → `journal_mode = DELETE` → remove `-wal`/`-shm` sidecars → `chmod 0o444`.
 * Idempotent. Throws if the checkpoint cannot complete (another writer holds the DB).
 */
export function sealDatabase(path: string): void {
	// A previously sealed artifact needs the write bit back for the journal-mode switch.
	if (isSealed(path)) chmodSync(path, 0o644)
	const db = new (sqlite().DatabaseSync)(path)
	const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number }

	if (checkpoint.busy !== 0) {
		db.close()
		throw new Error(`sealDatabase: WAL checkpoint busy on ${path} — close all writers first`)
	}
	const mode = db.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode: string }
	db.close()

	if (mode.journal_mode !== "delete") {
		throw new Error(`sealDatabase: journal_mode switch failed on ${path} (still ${mode.journal_mode})`)
	}

	for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
		if (existsSync(sidecar)) unlinkSync(sidecar)
	}
	chmodSync(path, 0o444)
}

/**
 * Open a data artifact. Read-only by default. `write: true` is for builders working on UNsealed staging — against a
 * sealed artifact it throws {@link SealedArtifactError}.
 */
export function openBuiltDatabase(path: string, opts: { write?: boolean } = {}): DatabaseSync {
	if (opts.write) {
		if (isSealed(path)) throw new SealedArtifactError(path)

		return new (sqlite().DatabaseSync)(path)
	}

	return new (sqlite().DatabaseSync)(path, { readOnly: true })
}
