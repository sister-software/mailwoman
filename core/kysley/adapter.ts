// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { type Kysely, DialectAdapterBase, type MigrationLockOptions } from "kysely"

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
