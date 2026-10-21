/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Encodes and verifies offline commercial-license tokens of the form `mwl1.<payload>.<signature>`.
 *
 *   Ed25519 signs the payload. Verification checks the signature against trusted public keys. The module uses WebCrypto,
 *   so it runs in Node, browsers and Workers.
 */

import { z } from "zod"

import { fromBase64URL, toBase64URL, utf8Bytes, utf8Text } from "#crypto/base64url"
import { hexOf, sha256Bytes } from "#crypto/digest"
import { generateEd25519KeyPair, publicKeyDER, signEd25519, verifyEd25519 } from "#crypto/ed25519"
import { errorMessage } from "#errors/schema"
import { parseJSONStrict, stringifyJSON } from "#json"

/**
 * The token format's version prefix.
 */
export const LICENSE_KEY_PREFIX = "mwl1"

/**
 * The number of dot-separated parts in a token.
 */
const LICENSE_KEY_PARTS = 3

/**
 * A calendar date in `YYYY-MM-DD` format.
 */
const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "expected YYYY-MM-DD")

/**
 * The two branches of the dual license a token can grant.
 *
 * A commercial token releases the holder from the AGPL source offer.
 * An open-source token grants artifact access and leaves every AGPL obligation in place.
 */
export const LicenseTerms = {
	Commercial: "LicenseRef-Commercial",
	OpenSource: "AGPL-3.0-only",
} as const

export type LicenseTerms = (typeof LicenseTerms)[keyof typeof LicenseTerms]

/**
 * The route that issued a token.
 *
 * `commercial` is a purchase.
 * `evaluation` is the thirty-day route.
 * The other four are declarations of intent.
 */
export const LicenseIntent = {
	OpenSource: "open-source",
	NonProfit: "non-profit",
	Academic: "academic",
	Student: "student",
	Evaluation: "evaluation",
	Commercial: "commercial",
} as const

export type LicenseIntent = (typeof LicenseIntent)[keyof typeof LicenseIntent]

/**
 * The prefix of a scope entry that is an atlas tier rather than a package.
 */
export const TIER_SCOPE_PREFIX = "tier:"

/**
 * The schema of a license-key payload.
 */
export const LicenseKeyPayloadSchema = z.object({
	/**
	 * The payload format version.
	 */
	v: z.literal(1),
	/**
	 * The signing key ID selects the trusted public key.
	 */
	kid: z.string().min(1),
	/**
	 * The license holder's name appears in `doctor` output.
	 */
	licensee: z.string().min(1),
	issued: CalendarDate,
	/**
	 * The last valid date, inclusive.
	 * A key without it does not expire.
	 */
	expires: CalendarDate.nullable().optional(),
	/**
	 * Either `all` or the list of packages and `tier:<name>` entries the token may download.
	 */
	scope: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]),
	/**
	 * The license branch that the key grants.
	 */
	terms: z.enum([LicenseTerms.Commercial, LicenseTerms.OpenSource]),
	/**
	 * An opaque serial for checking the license status online.
	 */
	lid: z.string().min(1).nullable().optional(),
	/**
	 * The version of the terms that the licensee accepted.
	 * A declared token has none.
	 */
	agreement: z.string().min(1).nullable().optional(),
	/**
	 * The route that issued the token.
	 * A hand-issued token has none.
	 */
	intent: z
		.enum([
			LicenseIntent.OpenSource,
			LicenseIntent.NonProfit,
			LicenseIntent.Academic,
			LicenseIntent.Student,
			LicenseIntent.Evaluation,
			LicenseIntent.Commercial,
		])
		.optional(),
	/**
	 * The issuance ordinal within the license, 1 for the first token.
	 */
	seq: z.number().int().min(1).optional(),
	/**
	 * The installation id the requesting CLI reported.
	 * The token is never bound to it.
	 */
	install: z.uuid().optional(),
})

/**
 * A validated license-key payload.
 */
export type LicenseKeyPayload = z.infer<typeof LicenseKeyPayloadSchema>

/**
 * A payload the worker issued, identified by its serial.
 *
 * A purchased token also has `agreement`.
 * A declared token has none.
 */
export type SelfServiceLicenseKeyPayload = LicenseKeyPayload & { lid: string }

/**
 * Returns whether a payload has a `lid`.
 * The online status routes are keyed by it.
 */
export function isSelfServicePayload(payload: LicenseKeyPayload): payload is SelfServiceLicenseKeyPayload {
	return typeof payload.lid === "string"
}

/**
 * Returns whether a scope admits an artifact.
 * An artifact is a package name or a `tier:<name>` entry.
 */
export function scopeAdmits(scope: LicenseKeyPayload["scope"], artifact: string): boolean {
	return scope === "all" || scope.includes(artifact)
}

/**
 * The result of verifying a token.
 * Every failure status includes a reason.
 */
export type LicenseKeyVerification =
	| { status: "valid"; kid: string; payload: LicenseKeyPayload }
	| { status: "expired"; kid: string; payload: LicenseKeyPayload }
	| { status: "unknown_key"; kid: string; reason: string }
	| { status: "invalid"; reason: string }

/**
 * Returns whether a verification grants the commercial branch: the token is valid
 * and its terms are commercial.
 *
 * A valid open-source token answers false, so the AGPL branch and its notice stay in place for it.
 */
export function grantsCommercialTerms(key: LicenseKeyVerification | null | undefined): boolean {
	return key?.status === "valid" && key.payload.terms === LicenseTerms.Commercial
}

/**
 * An Ed25519 signing key pair with both keys PEM-encoded.
 */
export interface LicenseSigningKeyPair {
	privateKeyPEM: string
	publicKeyPEM: string
}

/**
 * Generates a new Ed25519 signing key pair.
 */
export function generateLicenseSigningKeyPair(): Promise<LicenseSigningKeyPair> {
	return generateEd25519KeyPair()
}

/**
 * Builds a key ID from the product major version and the first eight hex digits of the DER key's SHA-256.
 */
export async function licenseKeyID(publicKeyPEM: string, majorVersion: number): Promise<string> {
	const digest = hexOf(await sha256Bytes(publicKeyDER(publicKeyPEM))).slice(0, 8)

	return `v${majorVersion}-${digest}`
}

/**
 * Validates a payload and signs it with the issuer's private key.
 */
export async function encodeLicenseKey(payload: LicenseKeyPayload, privateKeyPEM: string): Promise<string> {
	const checked = LicenseKeyPayloadSchema.parse(payload)
	const body = `${LICENSE_KEY_PREFIX}.${toBase64URL(utf8Bytes(stringifyJSON(checked)))}`
	const signature = await signEd25519(utf8Bytes(body), privateKeyPEM)

	return `${body}.${toBase64URL(signature)}`
}

/**
 * Returns the last UTC millisecond of the expiration date.
 */
export function licenseExpiryInstant(expires: string): Date {
	return new Date(`${expires}T23:59:59.999Z`)
}

/**
 * Decodes a token's payload without verifying its signature.
 * Use the result only for display.
 */
export function decodeLicenseKeyPayload(token: string): LicenseKeyPayload | null {
	const parts = token.trim().split(".")

	if (parts.length !== LICENSE_KEY_PARTS || parts[0] !== LICENSE_KEY_PREFIX) return null

	try {
		return LicenseKeyPayloadSchema.parse(parseJSONStrict(utf8Text(fromBase64URL(parts[1] ?? ""))))
	} catch {
		return null
	}
}

/**
 * Verifies a token offline against trusted public keys keyed by key ID.
 *
 * Tests pass `now` to get a fixed clock.
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

	if (payload.expires && licenseExpiryInstant(payload.expires) < now) {
		return { status: "expired", kid: payload.kid, payload }
	}

	return { status: "valid", kid: payload.kid, payload }
}
