/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DialectAdapterBase, Kysely, type MigrationLockOptions } from "kysely"

export class SqliteAdapter extends DialectAdapterBase {
	override get supportsTransactionalDdl(): boolean {
		return false
	}

	override get supportsReturning(): boolean {
		return true
	}

	override async acquireMigrationLock(_db: Kysely<unknown>, _opt: MigrationLockOptions): Promise<void> {
		// SQLite only has one connection that's reserved by the migration system
		// for the whole time between acquireMigrationLock and releaseMigrationLock.
		// We don't need to do anything here.
	}

	override async releaseMigrationLock(_db: Kysely<unknown>, _opt: MigrationLockOptions): Promise<void> {
		// SQLite only has one connection that's reserved by the migration system
		// for the whole time between acquireMigrationLock and releaseMigrationLock.
		// We don't need to do anything here.
	}
}
