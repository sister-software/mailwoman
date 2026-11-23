// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Encodes and verifies Mailwoman's offline product tokens: platform license keys
 *   (`mwl1`) and commercial training grants (`mwt1`).
 *
 *   `@mailwoman/license/product/token` defines the wire format and payload schemas,
 *   and `@mailwoman/license/product/trust` holds the trusted public keys.
 *   This module adds the Ed25519 signatures, on WebCrypto, so it runs in Node, browsers and Workers.
 *
 *   The Rust verifier in `packages/license/crates/product-license` reads the
 *   same fixtures and returns the same statuses.
 */

import {
	LICENSE_KEY_PREFIX,
	type LicenseKeyPayload,
	LicenseKeyPayloadSchema,
	type LicenseKeyVerification,
	licenseExpiryInstant,
	type ProductTokenParts,
	type ProductTokenPrefix,
	type ProductTokenVerification,
	schemaIssue,
	splitProductToken,
	TRAINING_GRANT_PREFIX,
	type TrainingGrantPayload,
	TrainingGrantPayloadSchema,
	type TrainingGrantVerification,
} from "@mailwoman/license/product/token"
import type { z } from "zod"

import { fromBase64URL, toBase64URL, utf8Bytes } from "#crypto/base64url"
import { hexOf, sha256Bytes } from "#crypto/digest"
import {
	ED25519_SIGNATURE_BYTES,
	generateEd25519KeyPair,
	publicKeyDER,
	signEd25519,
	verifyEd25519,
} from "#crypto/ed25519"
import { stringifyJSON } from "#values/json"

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
 * Builds a key ID from a one-letter use, the product major version and the first
 * eight hex digits of the DER key's SHA-256.
 *
 * A license key's use is `v`, a provenance key's `p`.
 */
async function keyID(publicKeyPEM: string, majorVersion: number, use: "v" | "p"): Promise<string> {
	const digest = hexOf(await sha256Bytes(publicKeyDER(publicKeyPEM))).slice(0, 8)

	return `${use}${majorVersion}-${digest}`
}

/**
 * The key ID of a license signing key: `v<major>-<eight hex digits>`.
 */
export function licenseKeyID(publicKeyPEM: string, majorVersion: number): Promise<string> {
	return keyID(publicKeyPEM, majorVersion, "v")
}

/**
 * The key ID of a provenance signing key: `p<major>-<eight hex digits>`.
 */
export function provenanceKeyID(publicKeyPEM: string, majorVersion: number): Promise<string> {
	return keyID(publicKeyPEM, majorVersion, "p")
}

async function encodeProductToken(prefix: ProductTokenPrefix, payload: object, privateKeyPEM: string): Promise<string> {
	const body = `${prefix}.${toBase64URL(utf8Bytes(stringifyJSON(payload)))}`
	const signature = await signEd25519(utf8Bytes(body), privateKeyPEM)

	return `${body}.${toBase64URL(signature)}`
}

/**
 * Validates a platform key payload and signs it with the issuer's private key.
 */
export async function encodeLicenseKey(payload: LicenseKeyPayload, privateKeyPEM: string): Promise<string> {
	return encodeProductToken(LICENSE_KEY_PREFIX, LicenseKeyPayloadSchema.parse(payload), privateKeyPEM)
}

/**
 * Validates a training grant payload and signs it with the issuer's private key.
 */
export async function encodeTrainingGrant(payload: TrainingGrantPayload, privateKeyPEM: string): Promise<string> {
	return encodeProductToken(TRAINING_GRANT_PREFIX, TrainingGrantPayloadSchema.parse(payload), privateKeyPEM)
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true })

/**
 * A token read as far as its signature: its parts and its validated payload, or the reason it's malformed.
 */
type ProductTokenReading<P> = { parts: ProductTokenParts; payload: P } | { reason: string }

/**
 * Reads a token of one prefix without checking its signature.
 *
 * It checks the three parts, the payload's base64url, UTF-8 and JSON, and the payload schema, in that order.
 * The first step that fails gives the reason.
 */
function readProductToken<P>(token: string, prefix: ProductTokenPrefix, schema: z.ZodType<P>): ProductTokenReading<P> {
	const parts = splitProductToken(token)

	if ("reason" in parts) {
		return parts
	}

	if (parts.prefix !== prefix) {
		return { reason: `a ${parts.prefix} token, not a ${prefix} token` }
	}

	let text: string

	try {
		text = STRICT_UTF8.decode(fromBase64URL(parts.payload))
	} catch {
		return { reason: "payload unreadable: not base64url-encoded UTF-8" }
	}

	let value: unknown

	try {
		// oxlint-disable-next-line no-restricted-properties -- `parseJSONStrict` wraps the error and loses the reason the fixtures record.
		value = JSON.parse(text)
	} catch {
		return { reason: "payload unreadable: not JSON" }
	}

	const parsed = schema.safeParse(value)

	return parsed.success
		? { parts, payload: parsed.data }
		: { reason: `payload unreadable: ${schemaIssue(parsed.error)}` }
}

/**
 * Decodes a token's payload without verifying its signature.
 * Use the result only for display.
 */
export function decodeLicenseKeyPayload(token: string): LicenseKeyPayload | null {
	const reading = readProductToken(token, LICENSE_KEY_PREFIX, LicenseKeyPayloadSchema)

	return "payload" in reading ? reading.payload : null
}

async function verifyProductToken<P extends { kid: string; expires?: string | null }>(
	token: string,
	prefix: ProductTokenPrefix,
	schema: z.ZodType<P>,
	options: { trustedKeys: Readonly<Record<string, string>>; now?: Date }
): Promise<ProductTokenVerification<P>> {
	const reading = readProductToken(token, prefix, schema)

	if ("reason" in reading) {
		return { status: "invalid", reason: reading.reason }
	}

	const { parts, payload } = reading
	const publicKeyPEM = options.trustedKeys[payload.kid]

	if (!publicKeyPEM) {
		return {
			status: "unknown_key",
			kid: payload.kid,
			reason: `signed by key id ${payload.kid}, which this build does not trust`,
		}
	}

	const signature = fromBase64URL(parts.signature)

	const signed =
		signature.length === ED25519_SIGNATURE_BYTES &&
		(await verifyEd25519(utf8Bytes(parts.signed), publicKeyPEM, signature))

	if (!signed) {
		return { status: "invalid", reason: `signature does not verify under key id ${payload.kid}` }
	}

	const expires = payload.expires
	const expired = expires != null && licenseExpiryInstant(expires) < (options.now ?? new Date())

	return { status: expired ? "expired" : "valid", kid: payload.kid, payload }
}

/**
 * Verifies a platform license key offline against trusted public keys keyed by key ID.
 *
 * Tests pass `now` to get a fixed clock.
 */
export function verifyLicenseKey(
	token: string,
	options: { trustedKeys: Readonly<Record<string, string>>; now?: Date }
): Promise<LicenseKeyVerification> {
	return verifyProductToken(token, LICENSE_KEY_PREFIX, LicenseKeyPayloadSchema, options)
}

/**
 * Verifies a commercial training grant offline against trusted public keys keyed by key ID.
 *
 * A valid grant still needs its permissions checked: {@linkcode trainingAdmission} in
 * `@mailwoman/license/product/entitlement` checks that it permits training.
 */
export function verifyTrainingGrant(
	token: string,
	options: { trustedKeys: Readonly<Record<string, string>>; now?: Date }
): Promise<TrainingGrantVerification> {
	return verifyProductToken(token, TRAINING_GRANT_PREFIX, TrainingGrantPayloadSchema, options)
}
