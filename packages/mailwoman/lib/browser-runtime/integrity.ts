// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The byte length and SHA-256 digest a release's manifest records for each artifact
 *   it ships, and the fetch wrapper that checks a downloaded body against them.
 *
 *   A torn or truncated body can reach the page with a 200 status, for example from a
 *   CDN object served without `Content-Length` or from a cache entry stored short.
 *   The loader compares each such body against the manifest, because its status is still 200.
 */

import { ArtifactLoadError } from "#browser-runtime/artifact-ledger"

/**
 * What the publisher measured for one file in a release directory.
 */
export interface ArtifactIntegrity {
	/**
	 * The file's length in bytes.
	 */
	bytes: number
	/**
	 * The lowercase hex SHA-256 digest of the file's bytes.
	 */
	sha256: string
}

/**
 * The integrity records of one release, keyed by file name in the release directory,
 * such as `model.onnx` or `postcode-us.bin`.
 */
export type ArtifactIntegrityTable = Record<string, ArtifactIntegrity>

/**
 * A downloaded artifact whose body differs from the manifest's record, on the first attempt
 * and on the retry that bypassed the HTTP cache.
 *
 * It is an {@linkcode ArtifactLoadError}, so a host that reports failed release loads reports this one.
 * The ledger records both attempts as completed transfers, so the error's `artifact` is `null`.
 */
export class ArtifactIntegrityError extends ArtifactLoadError {
	/**
	 * The file name in the release directory.
	 */
	readonly file: string
	readonly url: string

	constructor(file: string, url: string, detail: string) {
		super(null, new Error(`${file} failed its integrity check after a reload (${detail}): ${url}`))
		this.name = "ArtifactIntegrityError"
		this.file = file
		this.url = url
	}
}

const SHA256_HEX = /^[0-9a-f]{64}$/u

function isArtifactIntegrity(raw: unknown): raw is ArtifactIntegrity {
	if (typeof raw !== "object" || raw === null) return false

	const candidate = raw as Partial<ArtifactIntegrity>

	return (
		typeof candidate.bytes === "number" &&
		Number.isSafeInteger(candidate.bytes) &&
		candidate.bytes >= 0 &&
		typeof candidate.sha256 === "string" &&
		SHA256_HEX.test(candidate.sha256)
	)
}

/**
 * Read a release entry's `artifacts` wire field.
 *
 * A manifest published before the field returns `undefined`, and that release's downloads are not checked.
 *
 * @throws When the field is present but malformed, identifying the release and the file.
 * A malformed record is refused rather than skipped, because a skipped record
 * would turn the check off with no error.
 */
export function readArtifactIntegrityTable(raw: unknown, version: string): ArtifactIntegrityTable | undefined {
	if (raw == null) return undefined

	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new TypeError(`releases.json entry ${version}: artifacts is not an object keyed by file name`)
	}

	const table: ArtifactIntegrityTable = {}

	for (const [file, record] of Object.entries(raw)) {
		if (!isArtifactIntegrity(record)) {
			throw new TypeError(`releases.json entry ${version}: artifacts["${file}"] is not a { bytes, sha256 } record`)
		}

		table[file] = { bytes: record.bytes, sha256: record.sha256 }
	}

	return table
}

/**
 * The byte length the manifest records for `file` in a release, or `null` when it records none.
 *
 * A service worker's torn-body check can take this as its expected length for a
 * response without a checkable `Content-Length`.
 */
export function expectedArtifactLength(
	release: { artifacts?: ArtifactIntegrityTable } | null,
	file: string
): number | null {
	return release?.artifacts?.[file]?.bytes ?? null
}

function toHex(digest: ArrayBuffer): string {
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * How `body` differs from `expected`, or `null` when it matches.
 *
 * The length is always compared.
 * The digest is compared where `crypto.subtle` exists.
 *
 * A page served over plain HTTP from a host other than localhost has no `crypto.subtle`.
 */
export async function artifactMismatch(
	body: Uint8Array<ArrayBuffer>,
	expected: ArtifactIntegrity
): Promise<string | null> {
	if (body.byteLength !== expected.bytes) {
		return `received ${body.byteLength} bytes, expected ${expected.bytes}`
	}

	const subtle = globalThis.crypto?.subtle

	if (!subtle) return null

	const digest = toHex(await subtle.digest("SHA-256", body))

	return digest === expected.sha256 ? null : `sha256 ${digest}, expected ${expected.sha256}`
}

/**
 * The manifest record that applies to one request: its file name and the measured values.
 */
export interface ExpectedArtifact {
	file: string
	integrity: ArtifactIntegrity
}

/**
 * Map each URL of a release directory to its manifest record.
 *
 * `urlOf` builds the URL a loader requests for a file name, so the lookup matches exactly what's fetched.
 */
export function artifactLookup(
	table: ArtifactIntegrityTable | undefined,
	urlOf: (file: string) => string
): (url: string) => ExpectedArtifact | null {
	if (!table) return () => null

	const byURL = new Map<string, ExpectedArtifact>()

	for (const [file, integrity] of Object.entries(table)) {
		byURL.set(urlOf(file), { file, integrity })
	}

	return (url) => byURL.get(url) ?? null
}

function requestURL(input: Parameters<typeof fetch>[0]): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

/**
 * Wrap `fetchImpl` so a successful response for a URL the lookup knows is checked against its record.
 *
 * A body that differs is fetched once more with `cache: "reload"`, which bypasses the
 * browser's HTTP cache and tells a service worker to pass over its stored copy.
 * A caller's `no-store` is kept, because it already bypasses both.
 *
 * A second mismatch throws {@linkcode ArtifactIntegrityError}.
 *
 * An error status, and a URL the lookup doesn't know, pass through unchanged.
 * The returned response holds the checked bytes, so a caller reads it as it would read the original.
 */
export function verifyingFetch(
	fetchImpl: typeof fetch,
	expectedFor: (url: string) => ExpectedArtifact | null
): typeof fetch {
	return async (input, init) => {
		const expected = expectedFor(requestURL(input))

		if (!expected) return fetchImpl(input, init)

		const first = await fetchImpl(input, init)

		if (!first.ok) return first

		const firstBody = new Uint8Array(await first.arrayBuffer())

		if (!(await artifactMismatch(firstBody, expected.integrity))) return rebuild(first, firstBody)

		const reloadMode: NonNullable<RequestInit["cache"]> = init?.cache === "no-store" ? "no-store" : "reload"
		const second = await fetchImpl(input, { ...init, cache: reloadMode })

		if (!second.ok) return second

		const secondBody = new Uint8Array(await second.arrayBuffer())
		const mismatch = await artifactMismatch(secondBody, expected.integrity)

		if (mismatch) throw new ArtifactIntegrityError(expected.file, requestURL(input), mismatch)

		return rebuild(second, secondBody)
	}
}

function rebuild(response: Response, body: Uint8Array<ArrayBuffer>): Response {
	return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
