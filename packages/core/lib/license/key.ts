/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The commercial license key: a signed, self-describing token verified offline.
 *
 *   Format: `mwl1.<payload>.<signature>`, both parts base64url. The payload is JSON ({@link LicenseKeyPayload}); the
 *   signature is Ed25519 over the UTF-8 bytes of `mwl1.<payload>` — the prefix is inside the signed bytes so a token
 *   cannot be replayed under another format version. Verification needs only the public keys the register ships, so it
 *   works with no network; the well-known file on mailwoman.ai is a freshness check on top, not the anchor.
 *
 *   Why a signature and not an HMAC: an HMAC is verified with the same secret that mints it, so shipping a verifier would
 *   ship the minting key, and the alternative is a license server. Ed25519 keeps the private key with the issuer.
 *
 *   Signing and verification run on WebCrypto and the codec on the web platform's primitives, so this module has no
 *   `node:` import and runs where a Cloudflare Worker and a browser run as well as under Node.
 */

import { z } from "zod"

import { fromBase64URL, toBase64URL, utf8Bytes, utf8Text } from "#crypto/base64url"
import { hexOf, sha256Bytes } from "#crypto/digest"
import { generateEd25519KeyPair, publicKeyDER, signEd25519, verifyEd25519 } from "#crypto/ed25519"
import { errorMessage } from "#errors/schema"
import { parseJSONStrict } from "#json"

/**
 * The format prefix, bumped only when the payload schema or signing scheme changes incompatibly.
 */
export const LICENSE_KEY_PREFIX = "mwl1"

/**
 * A token is prefix, payload and signature — three dot-separated parts, no more and no fewer.
 */
const LICENSE_KEY_PARTS = 3

/**
 * A calendar date as `YYYY-MM-DD`. Dates, not instants: a license runs to the end of its last day in UTC.
 */
const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "expected YYYY-MM-DD")

/**
 * What a license key asserts.
 */
export const LicenseKeyPayloadSchema = z.object({
	/**
	 * Payload schema version.
	 */
	v: z.literal(1),
	/**
	 * The signing key's id ({@link licenseKeyID}); the verifier looks the public key up by it.
	 */
	kid: z.string().min(1),
	/**
	 * Who holds the license, as it should read in the doctor.
	 */
	licensee: z.string().min(1),
	issued: CalendarDate,
	/**
	 * The last day the key is valid, inclusive, or absent for a key with no expiry.
	 */
	expires: CalendarDate.optional(),
	/**
	 * `all`, or the package names the agreement covers.
	 */
	scope: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]),
	/**
	 * The SPDX branch the key selects. One value today; the field exists so a different agreement can be named later.
	 */
	terms: z.literal("LicenseRef-Commercial"),
	/**
	 * An opaque per-license serial a self-service issuer sets, stable for the subscription's life. Online status is keyed
	 * by it, and it names nothing about the customer.
	 */
	lid: z.string().min(1).optional(),
	/**
	 * The version of the clickwrap terms the licensee accepted, set by a self-service issuer.
	 */
	agreement: z.string().min(1).optional(),
})

export type LicenseKeyPayload = z.infer<typeof LicenseKeyPayloadSchema>

/**
 * A payload a self-service issuer produced: both fields present. A hand-issued payload has neither.
 */
export type SelfServiceLicenseKeyPayload = LicenseKeyPayload & { lid: string; agreement: string }

export function isSelfServicePayload(payload: LicenseKeyPayload): payload is SelfServiceLicenseKeyPayload {
	return typeof payload.lid === "string" && typeof payload.agreement === "string"
}

/**
 * The outcome of verifying a token. Every failure names its reason; a caller that only wants a yes reads `status`.
 */
export type LicenseKeyVerification =
	| { status: "valid"; kid: string; payload: LicenseKeyPayload }
	| { status: "expired"; kid: string; payload: LicenseKeyPayload }
	| { status: "unknown_key"; kid: string; reason: string }
	| { status: "invalid"; reason: string }

/**
 * A freshly generated Ed25519 signing pair, both halves PEM-encoded.
 */
export interface LicenseSigningKeyPair {
	privateKeyPEM: string
	publicKeyPEM: string
}

export function generateLicenseSigningKeyPair(): Promise<LicenseSigningKeyPair> {
	return generateEd25519KeyPair()
}

/**
 * The id a public key is registered under: the mailwoman major version it was minted for, then the first eight hex
 * digits of the SHA-256 of the key's DER encoding — `v9-3f2a9c1d`. The version prefix is what lets a well-known file on
 * mailwoman.ai be read per major version; the digest is what makes two keys distinguishable without a registry.
 */
export async function licenseKeyID(publicKeyPEM: string, majorVersion: number): Promise<string> {
	const digest = hexOf(await sha256Bytes(publicKeyDER(publicKeyPEM))).slice(0, 8)

	return `v${majorVersion}-${digest}`
}

/**
 * Sign a payload into a token. The issuer's private key never leaves the machine that calls this.
 */
export async function encodeLicenseKey(payload: LicenseKeyPayload, privateKeyPEM: string): Promise<string> {
	const checked = LicenseKeyPayloadSchema.parse(payload)
	const body = `${LICENSE_KEY_PREFIX}.${toBase64URL(utf8Bytes(JSON.stringify(checked)))}`
	const signature = await signEd25519(utf8Bytes(body), privateKeyPEM)

	return `${body}.${toBase64URL(signature)}`
}

/**
 * The last instant a key with this expiry is valid: the end of that day in UTC.
 */
function expiryInstant(expires: string): Date {
	return new Date(`${expires}T23:59:59.999Z`)
}

/**
 * The payload a token carries, AS WRITTEN and unverified: for reporting what a token this build cannot verify claims
 * (its key id, its license id), never for a decision. `undefined` for anything that is not a well-formed token.
 */
export function decodeLicenseKeyPayload(token: string): LicenseKeyPayload | undefined {
	const parts = token.trim().split(".")

	if (parts.length !== LICENSE_KEY_PARTS || parts[0] !== LICENSE_KEY_PREFIX) return undefined

	try {
		return LicenseKeyPayloadSchema.parse(parseJSONStrict(utf8Text(fromBase64URL(parts[1] ?? ""))))
	} catch {
		return undefined
	}
}

/**
 * Verify a token against the trusted public keys, keyed by kid. Offline; `now` is injectable for tests.
 */
export async function verifyLicenseKey(
	token: string,
	options: { trustedKeys: Readonly<Record<string, string>>; now?: Date }
): Promise<LicenseKeyVerification> {
	const parts = token.trim().split(".")

	if (parts.length !== LICENSE_KEY_PARTS || parts[0] !== LICENSE_KEY_PREFIX) {
		return { status: "invalid", reason: `not a ${LICENSE_KEY_PREFIX} token (expected three dot-separated parts)` }
	}

	const [prefix, payloadPart, signaturePart] = parts as [string, string, string]
	let payload: LicenseKeyPayload

	try {
		payload = LicenseKeyPayloadSchema.parse(parseJSONStrict(utf8Text(fromBase64URL(payloadPart))))
	} catch (error) {
		return { status: "invalid", reason: `payload unreadable: ${errorMessage(error)}` }
	}

	const publicKeyPEM = options.trustedKeys[payload.kid]

	if (!publicKeyPEM) {
		return {
			status: "unknown_key",
			kid: payload.kid,
			reason: `signed by key id ${payload.kid}, which this build does not trust`,
		}
	}

	const signed = await verifyEd25519(utf8Bytes(`${prefix}.${payloadPart}`), publicKeyPEM, fromBase64URL(signaturePart))

	if (!signed) {
		return { status: "invalid", reason: `signature does not verify under key id ${payload.kid}` }
	}

	const now = options.now ?? new Date()

	if (payload.expires && expiryInstant(payload.expires) < now) {
		return { status: "expired", kid: payload.kid, payload }
	}

	return { status: "valid", kid: payload.kid, payload }
}
