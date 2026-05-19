/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed wrapper around `@dsnp/parquetjs`'s schema definition. Adds:
 *
 *   - `ParquetSchema<T>`: a generic class narrowing the base schema's `schema` property to a
 *       field-by-field typed dict.
 *   - `ParquetSchemaDefinitionCache`: an LRU lookup so hot paths that compute the same schema
 *       repeatedly pay the cost once. Implements `Disposable` so `using` works.
 *   - `createBloomFilters<T>`: helper that takes a schema and a list of columns and returns the
 *       `@dsnp/parquetjs`-shaped bloom-filter spec array.
 *
 *   Salvaged 2026-05-17 from `isp-nexus/universe@6eeb7bd99643a6d62a8b8abbd50968a1e492b90b`
 *   `sdk/parquet/schema.ts` (originally copyright OpenISP, Inc.; both projects are AGPL-3.0). Two
 *   trims relative to the original: (a) `ParquetSchemaDefinitionCache`'s LRU generics use
 *   `ParquetRecordLike` instead of `any` to satisfy this project's eslint config; (b)
 *   `Symbol.dispose` is sync (the original was async, but `Disposable`'s contract is sync — async
 *   cleanup belongs on `AsyncDisposable`).
 */

import { ParquetSchema as BaseParquetSchema } from "@dsnp/parquetjs"
import type { createSBBFParams as BloomFilterCreation } from "@dsnp/parquetjs/dist/lib/bloomFilterIO/bloomFilterWriter.js"
import type { FieldDefinition } from "@dsnp/parquetjs/dist/lib/declare.js"
import { LRUCache } from "lru-cache"

/** A Parquet record-like object, i.e. a record with string keys and JSON-serializable values. */
export type ParquetRecordLike = {
	[key: string]: unknown | undefined
}

/** Typed Parquet schema definition. */
export type ParquetSchemaDefinition<T = ParquetRecordLike> = {
	[field in Extract<keyof T, string>]: FieldDefinition
}

/** Typed Parquet schema. */
export class ParquetSchema<T> extends BaseParquetSchema {
	declare schema: ParquetSchemaDefinition<T>
}

/** Given a Parquet schema and a list of columns, create a list of Bloom filters for those columns. */
export function createBloomFilters<T>(
	parquetSchemaDef: ParquetSchemaDefinition<T>,
	columns: Extract<keyof T, string>[]
) {
	const bloomFilters: BloomFilterCreation[] = []

	for (const column of columns) {
		if (!parquetSchemaDef[column]) {
			throw new Error(`Bloom filter column ${column} not found in Parquet schema`)
		}

		bloomFilters.push({ column })
	}

	return bloomFilters
}

export class ParquetSchemaDefinitionCache
	extends LRUCache<ParquetSchemaDefinition<ParquetRecordLike>, ParquetSchema<ParquetRecordLike>>
	implements Disposable
{
	constructor(max = 1000) {
		super({ max })
	}

	public findOrCreateSchema<T extends ParquetRecordLike>(schemaDef: ParquetSchemaDefinition<T>): ParquetSchema<T> {
		const key = schemaDef as ParquetSchemaDefinition<ParquetRecordLike>
		let schema = this.get(key) as ParquetSchema<T> | undefined

		if (!schema) {
			schema = new ParquetSchema<T>(schemaDef)
			this.set(key, schema as ParquetSchema<ParquetRecordLike>)
		}

		return schema
	}

	public [Symbol.dispose]() {
		this.clear()
	}
}
