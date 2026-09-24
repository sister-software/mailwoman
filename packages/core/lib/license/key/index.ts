/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Encode and verify offline commercial-license tokens in the form
 *   `mwl1.<payload>.<signature>`. Ed25519 signs the versioned payload; verification uses trusted
 *   public keys. WebCrypto keeps the module usable in Node, browsers, and Workers.
 */

import { z } from "zod"

import { fromBase64URL, toBase64URL, utf8Bytes, utf8Text } from "#crypto/base64url"
import { hexOf, sha256Bytes } from "#crypto/digest"
import { generateEd25519KeyPair, publicKeyDER, signEd25519, verifyEd25519 } from "#crypto/ed25519"
import { errorMessage } from "#errors/schema"
import { parseJSONStrict, stringifyJSON } from "#json"

/**
 * Version prefix for the token format.
 */
export const LICENSE_KEY_PREFIX = "mwl1"

/**
 * Number of dot-separated token parts.
 */
const LICENSE_KEY_PARTS = 3

/**
 * Calendar date in `yyyy-MM-DD` format.
 */
const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "expected YYYY-MM-DD")

/**
 * License-key payload schema.
 */
export const LicenseKeyPayloadSchema = z.object({
	/**
	 * Payload format version.
	 */
	v: z.literal(1),
	/**
	 * Signing key ID used to select the trusted public key.
	 */
	kid: z.string().min(1),
	/**
	 * License holder name shown by `doctor`.
	 */
	licensee: z.string().min(1),
	issued: CalendarDate,
	/**
	 * Inclusive expiration date, or absent for a non-expiring key.
	 */
	expires: CalendarDate.optional(),
	/**
	 * `all`, or the package names the agreement covers.
	 */
	scope: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]),
	/**
	 * License terms selected by the key.
	 */
	terms: z.literal("LicenseRef-Commercial"),
	/**
	 * Opaque serial used to check online license status.
	 */
	lid: z.string().min(1).optional(),
	/**
	 * Version of the terms accepted by the licensee.
	 */
	agreement: z.string().min(1).optional(),
})

export type LicenseKeyPayload = z.infer<typeof LicenseKeyPayloadSchema>

/**
 * Payload containing the serial and accepted-agreement fields.
 */
export type SelfServiceLicenseKeyPayload = LicenseKeyPayload & { lid: string; agreement: string }

export function isSelfServicePayload(payload: LicenseKeyPayload): payload is SelfServiceLicenseKeyPayload {
	return typeof payload.lid === "string" && typeof payload.agreement === "string"
}

/**
 * The outcome of verifying a token.
 *
 * Every failure names its reason.
 * A caller that only wants a yes reads `status`.
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
 * Build a key ID from the product major version and the first eight SHA-256 hex digits of its DER key.
 */
export async function licenseKeyID(publicKeyPEM: string, majorVersion: number): Promise<string> {
	const digest = hexOf(await sha256Bytes(publicKeyDER(publicKeyPEM))).slice(0, 8)

	return `v${majorVersion}-${digest}`
}

/**
 * Sign a validated payload with the issuer's private key.
 */
export async function encodeLicenseKey(payload: LicenseKeyPayload, privateKeyPEM: string): Promise<string> {
	const checked = LicenseKeyPayloadSchema.parse(payload)
	const body = `${LICENSE_KEY_PREFIX}.${toBase64URL(utf8Bytes(stringifyJSON(checked)))}`
	const signature = await signEd25519(utf8Bytes(body), privateKeyPEM)

	return `${body}.${toBase64URL(signature)}`
}

/**
 * Return the final UTC instant of the expiration date.
 */
function expiryInstant(expires: string): Date {
	return new Date(`${expires}T23:59:59.999Z`)
}

/**
 * Decode a well-formed payload without verifying its signature.
 * Use for reporting only.
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
 * Verify a token against trusted public keys.
 *
 * Verification is offline; `now` supports deterministic tests.
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
