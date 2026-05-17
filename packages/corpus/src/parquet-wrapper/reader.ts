/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed wrapper around `@dsnp/parquetjs`'s `ParquetReader` that narrows the row-iterator generic to
 *   a user-supplied record type and adds `AsyncDisposable` support so `await using` cleans up the
 *   envelope reader without an explicit `close()`.
 *
 *   Salvaged 2026-05-17 from `isp-nexus/universe@6eeb7bd99643a6d62a8b8abbd50968a1e492b90b`
 *   `sdk/parquet/reader.ts` (originally copyright OpenISP, Inc.; both projects are AGPL-3.0). Two
 *   trims relative to the original: (a) removed the
 *   `@isp.nexus/core/polyfills/promises/withResolvers` import — Node 22 has it native; (b) replaced
 *   the `PathBuilderLike` (path-ts) type on `openFile` with the plain `string | URL` the
 *   `@dsnp/parquetjs` envelope reader accepts directly.
 */

import { ParquetReader as BaseParquetReader } from "@dsnp/parquetjs"
import { BufferReaderOptions } from "@dsnp/parquetjs/dist/lib/bufferReader.js"
import { ParquetEnvelopeReader } from "@dsnp/parquetjs/dist/lib/reader.js"
import { ParquetRecordLike, ParquetSchema } from "./schema.js"

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
