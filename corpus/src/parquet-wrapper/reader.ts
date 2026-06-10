/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed wrapper around `@dsnp/parquetjs`'s `ParquetReader` that narrows the row-iterator generic to
 *   a user-supplied record type and adds `AsyncDisposable` support so `await using` cleans up the
 *   envelope reader without an explicit `close()`.
 */

import { ParquetReader as BaseParquetReader } from "@dsnp/parquetjs"
import type { BufferReaderOptions } from "@dsnp/parquetjs/dist/lib/bufferReader.js"
import { ParquetEnvelopeReader } from "@dsnp/parquetjs/dist/lib/reader.js"
import { type ParquetRecordLike, ParquetSchema } from "./schema.js"

/** A typed Parquet reader, wrapping the base Parquet reader. */
export class ParquetReader<T extends ParquetRecordLike> extends BaseParquetReader implements AsyncDisposable {
	declare schema: ParquetSchema<T>

	static override async openFile<T extends ParquetRecordLike>(
		filePath: string | URL,
		options?: BufferReaderOptions
	): Promise<ParquetReader<T>> {
		const envelopeReader = await ParquetEnvelopeReader.openFile(filePath.toString(), options)

		return ParquetReader.openEnvelopeReader<T>(envelopeReader, options)
	}

	static override async openBuffer<T extends ParquetRecordLike>(buffer: Buffer, options?: BufferReaderOptions) {
		const envelopeReader = await ParquetEnvelopeReader.openBuffer(buffer, options)

		return this.openEnvelopeReader<T>(envelopeReader, options)
	}

	static override async openEnvelopeReader<T extends ParquetRecordLike>(
		envelopeReader: ParquetEnvelopeReader,
		opts?: BufferReaderOptions
	) {
		if (opts?.metadata) {
			return new ParquetReader<T>(opts.metadata, envelopeReader, opts)
		}

		try {
			await envelopeReader.readHeader()

			const metadata = await envelopeReader.readFooter()

			return new ParquetReader<T>(metadata, envelopeReader, opts)
		} catch (err) {
			await envelopeReader.close()
			throw err
		}
	}

	public override [Symbol.asyncIterator](): AsyncGenerator<T, void, unknown> {
		return super[Symbol.asyncIterator]() as AsyncGenerator<T, void, unknown>
	}

	public async [Symbol.asyncDispose]() {
		return this.close()
	}

	public async dispose() {
		return this[Symbol.asyncDispose]()
	}
}
