/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	Alpha2LanguageCode,
	Alpha3bLanguageCode,
	Alpha3bToAlpha2,
	isAlpha3bLanguageCode,
} from "@mailwoman/core/resources/languages"
import sqlite, { Options as SQLiteOptions } from "better-sqlite3"
import { PathBuilder, PathBuilderLike } from "path-ts"
import { tryWithBackoff } from "./DataSourceCache.js"
import { WhosOnFirstPlacetype } from "./placetypes/definition.js"

export interface PlacetypeDataSourceOptions<
	P extends WhosOnFirstPlacetype = WhosOnFirstPlacetype,
	L extends Alpha3bLanguageCode | Alpha2LanguageCode = Alpha3bLanguageCode,
> {
	placetype: P
	languageCode: L
	dataDirectory: PathBuilderLike
}

export interface PlacetypeRecord {
	/**
	 * The WhosOnFirst ID of the record.
	 */
	id: number
	/**
	 * The source of the record, e.g. "whosonfirst", "quattroshapes", etc.
	 */
	src: string
	/**
	 * The parent ID of the record
	 */
	parent_id: number
	/**
	 * The name of the record. This is the name of the record typically in English.
	 */
	name: string
	/**
	 * The preferred name of the record.
	 */
	preferred: string | null
	/**
	 * A common variant of the name.
	 */
	variant: string | null
	/**
	 * A colloquial usage of the name.
	 */
	colloquial: string | null
	/**
	 * An abbreviation of the name.
	 */
	abbr: string | null
	/**
	 * A short form of the name.
	 */
	short: string | null
}

/**
 * A data source for WhosOnFirst placetype records.
 */
export class PlacetypeDataSource implements Disposable {
	#db: sqlite.Database

	public static createPath<P extends WhosOnFirstPlacetype, L extends Alpha3bLanguageCode | Alpha2LanguageCode>({
		placetype,
		languageCode,
		dataDirectory,
	}: Pick<PlacetypeDataSourceOptions<P, L>, "placetype" | "languageCode" | "dataDirectory">) {
		const normalizedLanguageCode = isAlpha3bLanguageCode(languageCode)
			? Alpha3bToAlpha2.get(languageCode)
			: languageCode

		return PathBuilder.from(
			dataDirectory,
			placetype,
			`${normalizedLanguageCode}.db`
		) as unknown as PathBuilder<`/${P}/${L}.db`>
	}

	public prepareTables(): void {
		this.#db.exec(/* sql */ `

			CREATE TABLE IF NOT EXISTS records (
				'id' INTEGER NOT NULL,
				'src' TEXT NOT NULL,
				'name' TEXT NOT NULL,
				'preferred' TEXT,
				'variant' TEXT,
				'colloquial' TEXT,
				'abbr' TEXT,
				'short' TEXT,
				'parent_id' INTEGER,
				PRIMARY KEY ('id', 'src', 'name')
			);
		`)
	}

	public prepareIndexes(): void {
		this.#db.exec(/* sql */ `

			CREATE INDEX IF NOT EXISTS idx_id ON records ('id');
			CREATE INDEX IF NOT EXISTS idx_src ON records ('src');
			CREATE INDEX IF NOT EXISTS idx_name ON records ('name');
			CREATE INDEX IF NOT EXISTS idx_preferred ON records ('preferred');
			CREATE INDEX IF NOT EXISTS idx_variant ON records ('variant');
			CREATE INDEX IF NOT EXISTS idx_colloquial ON records ('colloquial');
			CREATE INDEX IF NOT EXISTS idx_abbr ON records ('abbr');
			CREATE INDEX IF NOT EXISTS idx_short ON records ('short');
			CREATE INDEX IF NOT EXISTS idx_parent_id ON records ('parent_id');
		`)
	}

	constructor(databasePath: PathBuilderLike, dbOptions?: SQLiteOptions) {
		this.#db = sqlite(databasePath.toString(), dbOptions)

		this.#db.pragma("busy_timeout = 10000")
		this.#db.pragma("journal_mode = WAL")
		this.#db.pragma("synchronous = OFF")

		this.prepareTables()
		//this.prepareIndexes()
	}

	public [Symbol.dispose]() {
		this.#db.close()
	}

	/**
	 * Find a placetype record by at least one criteria.
	 */

	public find(criteria: Partial<PlacetypeRecord>): IteratorObject<PlacetypeRecord> {
		const statement = this.#db.prepare<[], PlacetypeRecord>(/* sql */ `
			SELECT *
			FROM records
			WHERE ${Object.keys(criteria)
				.map((key) => `${key} = @${key}`)
				.join(" OR ")}
		`)

		return Iterator.from(statement.iterate())
	}

	/**
	 * Given a placetype record, insert or update into the database.
	 *
	 * @param record The placetype record to upsert.
	 */
	public async upsert(record: PlacetypeRecord): Promise<void> {
		const perform = () => {
			const statement = this.#db.prepare<PlacetypeRecord>(/* sql */ `
			INSERT INTO records
			(id, src, name, preferred, variant, colloquial, abbr, short, parent_id)
			VALUES (
				@id,
				@src,
				@name,
				@preferred,
				@variant,
				@colloquial,
				@abbr,
				@short,
				@parent_id
			)
			ON CONFLICT (id, src, name)
			DO UPDATE SET
			preferred = excluded.preferred,
			variant = excluded.variant,
			colloquial = excluded.colloquial,
			abbr = excluded.abbr,
			short = excluded.short,
			parent_id = excluded.parent_id
			`)

			statement.run(record)
		}

		await tryWithBackoff(5, perform)
	}
}
