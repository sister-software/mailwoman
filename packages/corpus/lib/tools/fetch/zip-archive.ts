/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Downloads one zip archive through an {@linkcode APIClient} and answers what arrived.
 *
 *   An INSPIRE ATOM service that publishes one archive per area is harvested through many small
 *   requests rather than through one large transfer, so the transfer runs on the client the harvest
 *   already paces and a test can drive it over a stubbed transport. `downloadToFile` runs on global
 *   `fetch`, which a unit test cannot intercept.
 *
 *   The body is checked against the zip local-file-header signature rather than against a length.
 *   Two publishers answer a withdrawn or misspelled path with an html page under http 200, and the
 *   advertised media type does not settle what arrived either: ČÚZK advertises
 *   `application/gml+xml` on a body it serves as `application/zip`, and the Dirección General del
 *   Catastro advertises `application/atom+xml` on its zipped GML. The signature is the one statement
 *   the body itself makes.
 */

import type { APIClient } from "@mailwoman/core/api"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import type { PathBuilderLike } from "path-ts"

/**
 * The first two bytes of every zip archive, `PK`.
 *
 * The check is on the signature rather than on a size, because an error page and a small
 * area's archive are told apart by what the body is rather than by how long it is.
 * A size floor between the two would be a number fitted to the archives measured.
 */
const ZIP_SIGNATURE = "PK"

/**
 * What one archive transfer delivered.
 */
export interface ZipArchiveDownload {
	/**
	 * The byte count of the delivered body, counted rather than read from a header or a feed.
	 *
	 * An INSPIRE feed's `length` attribute is a claim: Denmark's understates its file by
	 * 23 times, and Navarra states the same 34,987 on all 272 of its partitions.
	 */
	bytes: number
	sha256: string
	/**
	 * The `Last-Modified` the host served the archive under, or `null` where it served none.
	 */
	lastModified: string | null
}

export interface DownloadZipArchiveOptions {
	url: string
	dest: PathBuilderLike
	/**
	 * Per-request timeout, in milliseconds.
	 */
	timeout?: number
	signal?: AbortSignal
}

/**
 * Downloads one zip archive to `dest` and answers its byte count, digest and served modification time.
 *
 * @throws When the body does not begin with a zip signature, so an html error page
 * is never written to disk under an archive's name.
 */
export async function downloadZipArchive(
	client: Pick<APIClient, "fetch">,
	options: DownloadZipArchiveOptions
): Promise<ZipArchiveDownload> {
	const response = await client.fetch<ArrayBuffer>({
		method: "GET",
		url: options.url,
		responseType: "arraybuffer",
		timeout: options.timeout,
		signal: options.signal,
	})

	const bytes = Buffer.from(response.data)

	if (bytes.subarray(0, ZIP_SIGNATURE.length).toString("latin1") !== ZIP_SIGNATURE) {
		throw new Error(
			`${options.url} answered ${bytes.byteLength} bytes that do not begin with a zip signature, ` +
				`so the body is not the archive`
		)
	}

	await writeLocalFile(bytes, options.dest)

	// A stubbed transport may answer without headers at all, so the served modification
	// time is read defensively rather than indexed.
	const headers = response.headers as Record<string, string> | undefined

	return {
		bytes: bytes.byteLength,
		sha256: sha256Hex(bytes),
		lastModified: headers?.["last-modified"] ?? null,
	}
}
