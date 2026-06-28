/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed Parquet writer. Two static constructors mirror the base class:
 *
 *   - `openStream`: wrap an existing writable stream.
 *   - `openFile`: open a path on disk, ensuring the parent directory exists first.
 *
 *   Implements `AsyncDisposable` so `await using writer = await ParquetWriter.openFile(...)` flushes
 *   and closes cleanly. `close()` internally serializes against any in-flight flush so back-to-back
 *   dispose calls don't race.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"

import { ParquetWriter as BaseParquetWriter } from "@dsnp/parquetjs"
import type { WriterOptions } from "@dsnp/parquetjs/dist/lib/declare.js"
import { osopen, type WriteStreamMinimal } from "@dsnp/parquetjs/dist/lib/util.js"
import { ParquetEnvelopeWriter } from "@dsnp/parquetjs/dist/lib/writer.js"

import {
	type ParquetRecordLike,
	ParquetSchema,
	type ParquetSchemaDefinition,
	ParquetSchemaDefinitionCache,
} from "./schema.js"

/** A typed Parquet writer, wrapping the base Parquet writer. */
export class ParquetWriter<T extends ParquetRecordLike> extends BaseParquetWriter implements AsyncDisposable {
	declare schema: ParquetSchema<T>
	protected static readonly SchemaDefinitionCache = new ParquetSchemaDefinitionCache()
	#flushing: Promise<void> = Promise.resolve()

	static override async openStream<T extends ParquetRecordLike>(
		schemaLike: ParquetSchema<T> | ParquetSchemaDefinition<T>,
		outputStream: WriteStreamMinimal,
		opts: WriterOptions = {}
	): Promise<ParquetWriter<T>> {
		const schema =
			schemaLike instanceof ParquetSchema
				? schemaLike
				: ParquetWriter.SchemaDefinitionCache.findOrCreateSchema(schemaLike)

		const envelopeWriter = await ParquetEnvelopeWriter.openStream(schema, outputStream, opts)

		return new ParquetWriter<T>(schema, envelopeWriter, opts)
	}

	/** Convenience method to create a new buffered parquet writer that writes to the specified file. */
	static override async openFile<T extends ParquetRecordLike>(
		schemaLike: ParquetSchema<T> | ParquetSchemaDefinition<T>,
		sourcePath: string | Buffer | URL,
		opts?: WriterOptions
	): Promise<ParquetWriter<T>> {
		if (typeof sourcePath === "string") {
			await fs.mkdir(path.dirname(sourcePath), { recursive: true })
		}

		const outputStream = await osopen(sourcePath, opts)

		return ParquetWriter.openStream<T>(schemaLike, outputStream, opts)
	}

	// @note This fixes invalid Markdown in the base class JSDoc.
	/** Set a metadata key-value pair on the writer. */
	public override setMetadata(key: string, value: string): void {
		return super.setMetadata(key, value)
	}

	/** Append a row to the buffer. If the buffer is full, the data will be written to disk. */
	public override async appendRow(row: T): Promise<void> {
		return super.appendRow(row)
	}

	/** Flush all buffered data to disk, close the file, and release resources. */
	public override async close(): Promise<void> {
		await this.#flushing

		if (this.closed) return

		const { promise, resolve, reject } = Promise.withResolvers<void>()

		super.close().then(resolve, reject)

		this.#flushing = promise

		return this.#flushing
	}

	public async [Symbol.asyncDispose]() {
		return this.close()
	}

	public async dispose() {
		return this[Symbol.asyncDispose]()
	}
}
