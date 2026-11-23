// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The wire format of Mailwoman's own product credentials: the platform license key
 *   (`mwl1`) and the commercial training grant (`mwt1`).
 *
 *   A token is `<prefix>.<payload>.<signature>`. The payload is unpadded base64url of a UTF-8 JSON
 *   object, and the signature is unpadded base64url of an Ed25519 signature over the ASCII bytes
 *   `<prefix>.<payload>` exactly as they appear in the token. A verifier never re-encodes the payload.
 *
 *   This module holds the schemas and splits a token into its parts. It holds no cryptography: the
 *   TypeScript verifier (`@mailwoman/core/license/key`) checks signatures with WebCrypto, and the Rust
 *   verifier (`packages/license/crates/product-license`) checks them with `ed25519-dalek`. Both read the
 *   fixtures under `packages/license/test/fixtures/product/`, and
 *   `docs/engineering/reference/product-license-tokens.mdx` specifies the format.
 */

import { z } from "zod"

/**
 * The prefix of a platform license key.
 */
export const LICENSE_KEY_PREFIX = "mwl1"

/**
 * The prefix of a commercial training grant.
 *
 * A training grant is a separate token version, so a platform key never reads as one.
 * The download route reads only `mwl1` and refuses a training grant.
 */
export const TRAINING_GRANT_PREFIX = "mwt1"

/**
 * The prefixes a product verifier reads.
 */
export const ProductTokenPrefix = {
	LicenseKey: LICENSE_KEY_PREFIX,
	TrainingGrant: TRAINING_GRANT_PREFIX,
} as const

export type ProductTokenPrefix = (typeof ProductTokenPrefix)[keyof typeof ProductTokenPrefix]

/**
 * A calendar date in `YYYY-MM-DD` format, refused unless it's a real day.
 *
 * V8 reads month 13 as an invalid date, and an expiry comparison never reports an invalid date as passed.
 * V8 also rolls `2027-02-30` forward to March 2.
 *
 * The schema refuses both, so every verifier reads one instant per date.
 */
const CalendarDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/u, "expected YYYY-MM-DD")
	.refine((date) => {
		const instant = new Date(`${date}T00:00:00.000Z`)

		return !Number.isNaN(instant.getTime()) && instant.toISOString().startsWith(date)
	}, "expected a real calendar date")

/**
 * The two branches of the dual license a key can grant.
 *
 * A commercial key releases the holder from the AGPL source offer for platform use.
 * An open-source key grants artifact access and leaves every AGPL obligation in place.
 */
export const LicenseTerms = {
	Commercial: "LicenseRef-Commercial",
	OpenSource: "AGPL-3.0-only",
} as const

export type LicenseTerms = (typeof LicenseTerms)[keyof typeof LicenseTerms]

/**
 * The route that issued a platform key.
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
 * The prefix of a scope entry that's an atlas tier rather than a package.
 */
export const TIER_SCOPE_PREFIX = "tier:"

/**
 * The schema of a platform license key payload.
 *
 * The schema drops fields it doesn't define.
 * The Rust verifier ignores those fields too.
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
	 * A key without it doesn't expire.
	 */
	expires: CalendarDate.nullable().optional(),
	/**
	 * Either `all` or the list of packages and `tier:<name>` entries the key may download.
	 *
	 * The scope governs artifact access only.
	 * It grants no training permission, `all` included.
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
	 * A declared key has none.
	 */
	agreement: z.string().min(1).nullable().optional(),
	/**
	 * The route that issued the key.
	 * A hand-issued key has none.
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
	 * The issuance ordinal within the license, 1 for the first key.
	 */
	seq: z.number().int().min(1).optional(),
	/**
	 * The installation id the requesting CLI reported.
	 * The key is never bound to it.
	 */
	install: z.uuid().optional(),
})

/**
 * A validated platform license key payload.
 */
export type LicenseKeyPayload = z.infer<typeof LicenseKeyPayloadSchema>

/**
 * A payload the worker issued, identified by its serial.
 *
 * A purchased key also has `agreement`.
 * A declared key has none.
 */
export type SelfServiceLicenseKeyPayload = LicenseKeyPayload & { lid: string }

/**
 * The permissions a training grant's `permits` list can hold.
 *
 * Platform use, training and commercial use of a trained model are separate permissions.
 * A platform key has no `permits` list.
 */
export const TrainingPermission = {
	/**
	 * Run the commercial trainer, start, retry and resume its runs, and export the models it produces.
	 */
	Train: "train",
	/**
	 * Use, commercially, a model whose signed provenance records this grant's ID.
	 */
	Deploy: "deploy",
} as const

export type TrainingPermission = (typeof TrainingPermission)[keyof typeof TrainingPermission]

/**
 * The shape of a training grant ID: `mtg_` and 24 lowercase hex digits.
 */
export const TRAINING_GRANT_ID_PATTERN = /^mtg_[0-9a-f]{24}$/u

/**
 * The schema of a commercial training grant payload.
 *
 * The schema drops fields it doesn't define.
 * The Rust verifier ignores those fields too.
 */
export const TrainingGrantPayloadSchema = z.object({
	v: z.literal(1),
	kid: z.string().min(1),
	/**
	 * The stable, opaque grant ID.
	 *
	 * A renewal under the same agreement keeps it, so a run continued under a renewed grant keeps one record.
	 */
	grant: z.string().regex(TRAINING_GRANT_ID_PATTERN, "expected mtg_ and 24 lowercase hex digits"),
	/**
	 * The party the grant was negotiated with.
	 * Distributed provenance never copies it.
	 */
	holder: z.string().min(1),
	/**
	 * The version of the written training agreement the grant is issued under.
	 */
	agreement: z.string().min(1),
	issued: CalendarDate,
	/**
	 * The last valid date, inclusive.
	 * Every training grant expires.
	 */
	expires: CalendarDate,
	/**
	 * The permissions the grant holds.
	 *
	 * A verifier ignores a value it doesn't know, so a permission added later
	 * never widens what an older verifier admits.
	 */
	permits: z.array(z.string().min(1)).min(1),
})

/**
 * A validated commercial training grant payload.
 */
export type TrainingGrantPayload = z.infer<typeof TrainingGrantPayloadSchema>

/**
 * The result of verifying a token: one of four statuses.
 * The TypeScript and Rust verifiers share them.
 *
 * Every failure status includes a reason.
 */
export type ProductTokenVerification<P> =
	| { status: "valid"; kid: string; payload: P }
	| { status: "expired"; kid: string; payload: P }
	| { status: "unknown_key"; kid: string; reason: string }
	| { status: "invalid"; reason: string }

export type LicenseKeyVerification = ProductTokenVerification<LicenseKeyPayload>

export type TrainingGrantVerification = ProductTokenVerification<TrainingGrantPayload>

const BASE64URL = /^[A-Za-z0-9_-]+$/u

/**
 * The dot-separated parts of a token: prefix, payload and signature.
 */
const PRODUCT_TOKEN_PARTS = 3

/**
 * The three encoded parts of a product token.
 */
export interface ProductTokenParts {
	prefix: ProductTokenPrefix
	payload: string
	signature: string
	/**
	 * The ASCII text the signature covers: `<prefix>.<payload>`.
	 */
	signed: string
}

/**
 * Splits a token into its parts after trimming surrounding whitespace.
 *
 * Answers a reason for a token with other than three parts, an unknown prefix,
 * or a part outside the unpadded base64url alphabet.
 */
export function splitProductToken(token: string): ProductTokenParts | { reason: string } {
	const parts = token.trim().split(".")

	if (parts.length !== PRODUCT_TOKEN_PARTS)
		return { reason: "not a product token (expected three dot-separated parts)" }

	const [prefix, payload, signature] = parts as [string, string, string]

	if (prefix !== LICENSE_KEY_PREFIX && prefix !== TRAINING_GRANT_PREFIX) {
		return { reason: `unknown token prefix ${JSON.stringify(prefix)}` }
	}

	if (!BASE64URL.test(payload)) return { reason: "payload is not unpadded base64url" }

	if (!BASE64URL.test(signature)) return { reason: "signature is not unpadded base64url" }

	return { prefix, payload, signature, signed: `${prefix}.${payload}` }
}

/**
 * The first issue of a failed parse as one line: the field path and zod's message.
 */
export function schemaIssue(error: z.ZodError): string {
	const issue = error.issues[0]

	if (!issue) return "payload does not match its schema"

	return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message
}

/**
 * Returns the last UTC millisecond of an inclusive expiry date.
 *
 * A credential that expires on `2026-11-30` is valid at `2026-11-30T23:59:59.999Z`
 * and expired one millisecond later.
 */
export function licenseExpiryInstant(expires: string): Date {
	return new Date(`${expires}T23:59:59.999Z`)
}

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
