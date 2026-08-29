/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Opening a built data artifact.
 *
 *   This is the other half of the sealed-artifact invariant in `../utils/sealed-db.ts`: that module owns the
 *   filesystem side (seal, unseal-refusal, atomic swap) and stays free of a static `node:sqlite` import, because it
 *   rides the `@mailwoman/core/utils` barrel into consumers that cannot resolve one. The open lives here, where
 *   `DatabaseClient` is already imported and the cost is paid.
 */

import { DatabaseClient } from "./client.ts"
import type { Database } from "./database-schema.ts"
import { assertUnsealedForWrite } from "./sealed-db.ts"

/**
 * Open a built data artifact. Read-only by default; `write: true` is for builders working on UNsealed staging, and
 * throws `SealedArtifactError` against a sealed file.
 *
 * Together with `new DatabaseClient(path)` this is the whole set of ways a connection comes into being. `DatabaseSync`
 * is constructed in exactly one place, inside `DatabaseClient`, so no caller holds a raw handle and no database ends up
 * described by two schemas.
 */
export function openBuiltClient<DB = Database>(path: string, opts: { write?: boolean } = {}): DatabaseClient<DB> {
	if (opts.write) {
		assertUnsealedForWrite(path)

		return new DatabaseClient<DB>(path)
	}

	return new DatabaseClient<DB>(path, { readOnly: true })
}
