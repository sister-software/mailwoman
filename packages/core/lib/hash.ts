/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   File and content hashing utilities.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto"

import { openReadStream } from "#fs/streams"

/**
 * Streaming SHA-256 of a file, hex-encoded.
 */
export async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256")

	for await (const chunk of openReadStream(path)) {
		hash.update(chunk as Buffer)
	}

	return hash.digest("hex")
}

/**
 * SHA-256 of in-memory content, hex-encoded.
 */
export function sha256Hex(data: string | NodeJS.ArrayBufferView | string[]): string {
	const formattedData = Array.isArray(data) ? data.join("\n") : data

	return createHash("sha256").update(formattedData).digest("hex")
}

/**
 * Streaming MD5 of a file, hex-encoded. MD5 (not SHA-256) is used for build-provenance fingerprints that follow an
 * existing convention — the HM Land Registry PPD snapshot ships an `.md5` sibling, and
 * `gazetteer-pipeline/admin/index.ts`'s build-log fingerprint is MD5 — so a extract/artifact header recording a source
 * checksum matches the surrounding provenance chain rather than mixing algorithms. Not a security primitive; only ever
 * used for accidental-corruption / drift detection.
 */
export async function md5File(path: string): Promise<string> {
	const hash = createHash("md5")

	for await (const chunk of openReadStream(path)) {
		hash.update(chunk as Buffer)
	}

	return hash.digest("hex")
}

/**
 * MD5 of in-memory content, hex-encoded — the {@link md5File} counterpart for a string that never becomes a file. Same
 * provenance-only rationale, and the same non-security caveat: it exists so a query text, a manifest line or a config
 * blob can be fingerprinted with the SAME algorithm as the files recorded beside it in one `meta` table.
 */

export function md5Hex(data: string | NodeJS.ArrayBufferView): string {
	return createHash("md5").update(data).digest("hex")
}

/**
 * The incremental hasher, for input that arrives in pieces — a row at a time, a chunk at a time. For a whole value,
 * {@linkcode sha256Hex} and {@linkcode md5Hex} say which digest in their name.
 */
export { createHash, type Hash } from "node:crypto"

/**
 * An Ed25519 key pair, both halves PEM-encoded (PKCS#8 private, SPKI public) — the signing scheme behind the commercial
 * license key. Ed25519 because a signature is verifiable with the public half alone, which is what lets a verifier ship
 * inside the package without shipping the minting key.
 */
export interface Ed25519KeyPairPEM {
	privateKeyPEM: string
	publicKeyPEM: string
}

export function generateEd25519KeyPair(): Ed25519KeyPairPEM {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519")

	return {
		privateKeyPEM: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		publicKeyPEM: publicKey.export({ type: "spki", format: "pem" }).toString(),
	}
}

/**
 * Sign `data` with a PEM private key. Ed25519 has no digest parameter — the algorithm is fixed by the key.
 */
export function signEd25519(data: Uint8Array, privateKeyPEM: string): Uint8Array {
	return sign(null, data, createPrivateKey(privateKeyPEM))
}

/**
 * Verify an Ed25519 signature over `data` with a PEM public key. Answers `false` for a bad signature and never throws
 * on one; a malformed key still throws, because that is a caller error rather than an untrusted input.
 */
export function verifyEd25519(data: Uint8Array, publicKeyPEM: string, signature: Uint8Array): boolean {
	return verify(null, data, createPublicKey(publicKeyPEM), signature)
}

/**
 * The SPKI DER bytes of a PEM public key — the stable encoding to derive an identifier from, since PEM line wrapping
 * and trailing whitespace vary between writers.
 */
export function publicKeyDER(publicKeyPEM: string): Uint8Array {
	return createPublicKey(publicKeyPEM).export({ type: "spki", format: "der" })
}
