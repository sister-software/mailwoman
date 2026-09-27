/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shared shape of a reader over one SQLite artifact.
 *   A lookup either opens the file it is given or adopts a connection the caller already holds,
 *   and it closes on disposal only what it opened.
 */

import type { PathBuilderLike } from "path-ts"

import { DatabaseClient, type DatabaseSyncOptions } from "#client"

/**
 * Where a lookup's connection comes from.
 * Exactly one of the two fields is set.
 */
export interface SQLiteLookupOptions<DB> {
	/**
	 * The database file to open.
	 * The lookup owns the connection and closes it on disposal.
	 */
	databasePath?: PathBuilderLike
	/**
	 * A connection the caller opened.
	 * The lookup reads through it and leaves it open on disposal.
	 */
	database?: DatabaseClient<DB>
}

/**
 * A reader over one SQLite database that owns only the connection it opened.
 *
 * A subclass passes its options to `super` and reads through `this.database`.
 * It inherits the disposal that closes an opened file and leaves an adopted one alone.
 *
 * The connection is opened read-only unless the subclass passes its own open options.
 */
export abstract class SQLiteLookup<DB> implements Disposable {
	readonly #database: DatabaseClient<DB>
	/**
	 * The connections this instance opened.
	 *
	 * An adopted connection is never a member, so disposal cannot reach it.
	 */
	readonly #owned = new DisposableStack()

	protected constructor(source: SQLiteLookupOptions<DB>, openOptions: DatabaseSyncOptions = { readOnly: true }) {
		if (source.database && source.databasePath) {
			throw new Error(`${new.target.name}: pass either \`database\` or \`databasePath\`, not both`)
		}

		if (source.database) {
			this.#database = source.database
		} else if (source.databasePath) {
			this.#database = this.#owned.use(new DatabaseClient<DB>(source.databasePath, openOptions))
		} else {
			throw new Error(`${new.target.name}: one of \`database\` or \`databasePath\` is required`)
		}
	}

	/**
	 * The connection this lookup reads through.
	 */
	protected get database(): DatabaseClient<DB> {
		return this.#database
	}

	/**
	 * Close the connection this lookup opened.
	 * An adopted connection stays open for its owner.
	 */
	[Symbol.dispose](): void {
		this.#owned[Symbol.dispose]()
	}
}
