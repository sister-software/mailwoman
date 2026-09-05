/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ed25519 and SHA-256 on `crypto.subtle`, the one implementation Node, a Cloudflare Worker and a browser share. Keys
 *   travel as PEM: PKCS8 for the private half, SPKI for the public half, which is what `node:crypto` wrote before and
 *   what an operator's signing key file already holds. The PEM codec here is a base64 transform of the DER bytes the
 *   WebCrypto API imports and exports; nothing parses ASN.1.
 *
 *   Signing is deterministic in Ed25519, so a WebCrypto signature over the same key and bytes equals the `node:crypto`
 *   one byte for byte; the test holds that against a fixture produced before this module existed.
 */

import { fromBase64URL, toBase64URL } from "#crypto/base64url"

export interface Ed25519KeyPairPEM {
	privateKeyPEM: string
	publicKeyPEM: string
}

const ALGORITHM = { name: "Ed25519" } as const

/**
 * PEM wraps its base64 at this width; `node:crypto` writes the same, so a key round-trips through either writer.
 */
const PEM_LINE_WIDTH = 64

function pemToDER(pem: string): Uint8Array<ArrayBuffer> {
	const base64 = pem
		.replace(/-----BEGIN [A-Z ]+-----/u, "")
		.replace(/-----END [A-Z ]+-----/u, "")
		.replaceAll(/\s+/gu, "")

	// Standard base64 with padding; the url-safe decoder accepts it once the two alphabet characters are mapped.
	return fromBase64URL(base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""))
}

function derToPEM(der: Uint8Array<ArrayBuffer>, label: "PRIVATE KEY" | "PUBLIC KEY"): string {
	const base64 = toBase64URL(der).replaceAll("-", "+").replaceAll("_", "/")
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
	const lines = padded.match(new RegExp(`.{1,${PEM_LINE_WIDTH}}`, "gu")) ?? []

	return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

/**
 * The SPKI DER bytes of a PEM public key: the stable encoding to derive an identifier from, since PEM line wrapping and
 * trailing whitespace vary between writers.
 */
export function publicKeyDER(publicKeyPEM: string): Uint8Array<ArrayBuffer> {
	return pemToDER(publicKeyPEM)
}

export async function generateEd25519KeyPair(): Promise<Ed25519KeyPairPEM> {
	const pair = await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"])

	// The overload answers a single key for symmetric algorithms; Ed25519 always answers a pair, and narrowing by shape
	// keeps this module free of a global type name the Node typings do not declare.
	if (!("privateKey" in pair)) throw new TypeError("Ed25519 key generation answered a single key, not a pair")

	return {
		privateKeyPEM: derToPEM(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)), "PRIVATE KEY"),
		publicKeyPEM: derToPEM(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)), "PUBLIC KEY"),
	}
}

export async function signEd25519(
	data: Uint8Array<ArrayBuffer>,
	privateKeyPEM: string
): Promise<Uint8Array<ArrayBuffer>> {
	const key = await crypto.subtle.importKey("pkcs8", pemToDER(privateKeyPEM), ALGORITHM, false, ["sign"])

	return new Uint8Array(await crypto.subtle.sign(ALGORITHM, key, data))
}

/**
 * Answers `false` for a bad signature and never throws on one; a malformed KEY still throws, because that is a caller
 * error rather than an untrusted input.
 */
export async function verifyEd25519(
	data: Uint8Array<ArrayBuffer>,
	publicKeyPEM: string,
	signature: Uint8Array<ArrayBuffer>
): Promise<boolean> {
	const key = await crypto.subtle.importKey("spki", pemToDER(publicKeyPEM), ALGORITHM, false, ["verify"])

	try {
		return await crypto.subtle.verify(ALGORITHM, key, signature, data)
	} catch {
		return false
	}
}

export async function sha256Bytes(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", data))
}
