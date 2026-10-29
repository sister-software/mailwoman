/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Receipt-backed acquisition of one published artifact into the data root's staging area.
 *
 *   Each remote object stages under `<data-root>/tmp/acquire/<key>/`, on the filesystem the artifact is
 *   installed on, so the final move is a rename. The directory holds the partial bytes and a receipt naming
 *   the URL and the remote identity read before the transfer: its `ETag`, `Last-Modified` and length.
 *
 *   An interrupted transfer keeps its partial bytes. The next attempt resumes them only when the host still
 *   reports the same identity, and otherwise starts over and reports the reason. Completed bytes are verified against
 *   the published `.md5` sidecar when one exists and against the length otherwise. A transfer that cannot be
 *   verified by either is refused rather than trusted.
 */

import type { APIClient } from "@mailwoman/core/api"
import { acquireDirectoryLock } from "@mailwoman/core/fs/lock"
import { tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { md5File, sha256Hex } from "@mailwoman/core/hash"
import { ResumeRefusedError, streamToDisk } from "@mailwoman/core/utils"
import type { PathBuilder, PathBuilderLike } from "path-ts"

import { catalogPaths, writeRecordAtomically } from "#data/catalog"

/**
 * What the host reported about a remote object before the transfer.
 */
export interface RemoteIdentity {
	url: string
	/**
	 * The object's length, or `null` when the host reported none.
	 */
	contentLength: number | null
	etag: string | null
	lastModified: string | null
	/**
	 * The published `.md5` sidecar's digest, or `null` when the host publishes none.
	 */
	md5: string | null
}

/**
 * The record of one acquisition, kept beside its partial bytes and, once installed, beside the artifact.
 */
export interface AcquisitionReceipt {
	remote: RemoteIdentity
	/**
	 * The registry's object key.
	 *
	 * It ties an installed artifact back to the registry entry it came from.
	 */
	remotePath: string
	startedAt: string
	completedAt: string | null
	/**
	 * How the bytes were verified: `md5` against the sidecar, or `length` against the reported length.
	 */
	verifiedBy: "md5" | "length" | null
}

/**
 * One acquired file, verified, in the staging area.
 */
export interface AcquiredFile {
	path: string
	bytes: number
	receipt: AcquisitionReceipt
	/**
	 * Why earlier partial bytes were discarded, or `null` when there were none or they were resumed.
	 */
	restartReason: string | null
	/**
	 * The offset the transfer resumed from, or 0.
	 */
	resumedFrom: number
}

/**
 * A transfer that was cancelled, kept distinct from a failure and from a completed no-op.
 */
export class AcquisitionCancelledError extends Error {
	constructor(url: string, options?: ErrorOptions) {
		super(`the transfer of ${url} was cancelled; its partial bytes are kept for the next attempt`, options)
		this.name = "AcquisitionCancelledError"
	}
}

/**
 * Read the remote object's identity: its head and, when the registry records
 * one as published, its `.md5` sidecar.
 *
 * A head that fails leaves the identity unknown rather than throwing, because the
 * transfer that follows is the evidence of whether the object exists.
 * A sidecar that is declared and cannot be read is an error, because the
 * transfer could then not be verified.
 */
export async function readRemoteIdentity(
	client: APIClient,
	url: string,
	md5Sidecar: boolean,
	headers: Record<string, string> = {}
): Promise<RemoteIdentity> {
	const identity: RemoteIdentity = { url, contentLength: null, etag: null, lastModified: null, md5: null }

	try {
		// A cached head would answer the identity the object had when it was cached.
		const response = await client.fetch({ method: "head", url, headers, cache: false })
		const length = response.headers["content-length"]

		identity.contentLength = length ? Number(length) : null
		identity.etag = (response.headers["etag"] as string | undefined) ?? null
		identity.lastModified = (response.headers["last-modified"] as string | undefined) ?? null
	} catch {
		// The transfer below reports whether the object exists, and without an identity no partial bytes resume.
	}

	if (md5Sidecar) {
		const response = await client.fetch<string>({
			method: "get",
			url: `${url}.md5`,
			responseType: "text",
			headers: { ...headers, range: "bytes=0-" },
		})

		identity.md5 = String(response.data).trim().split(/\s+/)[0] ?? null
	}

	return identity
}

/**
 * Why partial bytes recorded under `earlier` cannot be continued against `current`, or `null` when they can.
 */
export function resumeRefusal(earlier: RemoteIdentity, current: RemoteIdentity): string | null {
	if (earlier.url !== current.url) return `the URL changed from ${earlier.url}`

	if (!current.etag && !current.lastModified) {
		return "the host reports neither an ETag nor a Last-Modified date, so the partial bytes cannot be matched to the object"
	}

	if (earlier.etag !== current.etag)
		return `the ETag changed from ${earlier.etag ?? "none"} to ${current.etag ?? "none"}`

	if (earlier.lastModified !== current.lastModified) {
		return `the object was modified (${earlier.lastModified ?? "no date"} then ${current.lastModified ?? "no date"})`
	}

	if (earlier.contentLength !== current.contentLength) {
		return `the length changed from ${earlier.contentLength ?? "unknown"} to ${current.contentLength ?? "unknown"}`
	}

	return null
}

/**
 * The staging directory for one remote object.
 */
export function acquisitionDirectory(dataRoot: PathBuilderLike, url: string): PathBuilder {
	return catalogPaths(dataRoot).acquisitions(sha256Hex(url).slice(0, 16))
}

/**
 * Acquire one remote object into the staging area, resuming earlier partial bytes
 * when the remote identity still matches.
 *
 * @param options.identity The remote identity read for this attempt.
 * @param options.downloadURL The URL to transfer from when it differs from the
 * identity's URL, such as a presigned URL.
 * @throws {@link AcquisitionCancelledError} when `signal` aborts, keeping the partial bytes.
 * @throws When the transfer fails or the bytes do not verify.
 * Partial bytes of a failed transfer are kept, and bytes that fail verification are removed.
 */
export async function acquireRemoteObject(options: {
	dataRoot: PathBuilderLike
	remotePath: string
	identity: RemoteIdentity
	downloadURL?: string
	headers?: Record<string, string>
	signal?: AbortSignal
	onProgress?: (message: string) => void
	now?: () => Date
}): Promise<AcquiredFile> {
	const now = options.now ?? (() => new Date())
	const { identity } = options
	const directory = acquisitionDirectory(options.dataRoot, identity.url)
	const partialPath = directory("object.part").toString()
	const finalPath = directory("object").toString()
	const receiptPath = directory("receipt.json")

	await makeDirectories(directory)

	// Two installers transferring one object would interleave their bytes in one partial file.
	await using _lock = await acquireDirectoryLock(
		`${directory.toString()}.lock`,
		(held) =>
			`another installer is transferring ${options.remotePath}` +
			(held ? ` (pid ${held.pid} on ${held.host} since ${held.started_at})` : "") +
			"; wait for it to finish and run the command again"
	)

	const earlier = await tryReadLocalJSONFile<AcquisitionReceipt>(receiptPath).catch(() => null)
	const partial = await tryStat(partialPath)
	let resumeFrom = 0
	let restartReason: string | null = null

	if (partial?.size) {
		const refusal = earlier ? resumeRefusal(earlier.remote, identity) : "the partial bytes have no receipt"

		if (refusal) {
			restartReason = `restarting the transfer of ${options.remotePath}: ${refusal}`
			await removePathIfPresent(partialPath)
		} else {
			resumeFrom = partial.size
		}
	}

	const receipt: AcquisitionReceipt = {
		remote: identity,
		remotePath: options.remotePath,
		startedAt: resumeFrom && earlier ? earlier.startedAt : now().toISOString(),
		completedAt: null,
		verifiedBy: null,
	}

	await writeRecordAtomically(receipt, receiptPath)

	// The transfer's own response states the object's length when the head did not:
	// `Content-Range` states the total, and `Content-Length` the bytes after the offset.
	let answeredLength: number | null = null

	const transfer = (offset: number) =>
		streamToDisk({
			url: options.downloadURL ?? identity.url,
			destination: finalPath,
			partialPath,
			context: "mailwoman data pull",
			headers: { ...options.headers },
			resumeFrom: offset,
			retainPartial: true,
			onResponse: (response) => {
				const total = /\/(\d+)$/u.exec(response.headers.get("content-range") ?? "")?.[1]
				const length = response.headers.get("content-length")

				answeredLength = total ? Number(total) : length ? offset + Number(length) : null
			},
			...(options.signal ? { signal: options.signal } : {}),
			...(options.onProgress ? { onProgress: options.onProgress } : {}),
		})

	let bytes: number

	try {
		try {
			bytes = await transfer(resumeFrom)
		} catch (error) {
			if (!(error instanceof ResumeRefusedError)) throw error

			restartReason = `restarting the transfer of ${options.remotePath}: ${error.message}`
			resumeFrom = 0
			await removePathIfPresent(partialPath)
			bytes = await transfer(0)
		}
	} catch (error) {
		if (options.signal?.aborted) throw new AcquisitionCancelledError(identity.url, { cause: error })

		throw error
	}

	let verifiedBy: AcquisitionReceipt["verifiedBy"]
	// The closure above assigns it, and TypeScript does not widen a type for a closure's assignment.
	const expectedLength = identity.contentLength ?? (answeredLength as number | null)

	if (identity.md5) {
		const got = await md5File(finalPath)

		if (got !== identity.md5) {
			await removePathIfPresent(finalPath)
			throw new Error(
				`${options.remotePath}: md5 mismatch (expected ${identity.md5}, got ${got}); the bytes were removed`
			)
		}

		verifiedBy = "md5"
	} else if (expectedLength != null) {
		if (bytes !== expectedLength) {
			await removePathIfPresent(finalPath)
			throw new Error(
				`${options.remotePath}: received ${bytes} bytes and the host reported ${expectedLength}; the bytes were removed`
			)
		}

		verifiedBy = "length"
	} else {
		await removePathIfPresent(finalPath)
		throw new Error(
			`${options.remotePath}: the host published neither an md5 sidecar nor a length, so the ${bytes} bytes received cannot be verified; the bytes were removed`
		)
	}

	const completed: AcquisitionReceipt = { ...receipt, completedAt: now().toISOString(), verifiedBy }

	await writeRecordAtomically(completed, receiptPath)

	return { path: finalPath, bytes, receipt: completed, restartReason, resumedFrom: resumeFrom }
}
