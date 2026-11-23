// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The register of Mailwoman's product signing keys, read from `trust-register.json`.
 *
 *   The JSON file is the one register the TypeScript verifiers, the Rust verifier
 *   (`packages/license/crates/product-license`, which embeds it) and the well-known file on
 *   mailwoman.post derive from, so none of them can disagree.
 *
 *   A license key signs platform keys (`mwl1`) and training grants (`mwt1`). A provenance key signs
 *   model provenance manifests. The two sets are separate, so a key held by the managed export
 *   environment can never mint a credential, and a license key can never attest to model bytes.
 *
 *   A key enters when `mailwoman license keygen` mints it and moves through three states:
 *
 *   - `active`: may sign and verify.
 *   - `retired`: may no longer sign. Material it signed still verifies offline until it expires.
 *   - `revoked`: compromised.
 *     Online status refuses its tokens at once.
 *     The derived trust maps omit the key, so the next release stops trusting it offline.
 */

import { z } from "zod"

import register from "./trust-register.json" with { type: "json" }

/**
 * The three states a signing key moves through, in order.
 * A key never moves back.
 */
export const LicenseKeyStatus = {
	Active: "active",
	Retired: "retired",
	Revoked: "revoked",
} as const

export type LicenseKeyStatus = (typeof LicenseKeyStatus)[keyof typeof LicenseKeyStatus]

const SigningKeySchema = z.object({
	/**
	 * `licenseKeyID(publicKeyPEM, majorVersions[0])` for a license key, starting with `v`.
	 *
	 * `provenanceKeyID` for a provenance key, starting with `p`.
	 * The register test checks that value for every entry.
	 */
	kid: z.string().regex(/^[vp]\d+-[0-9a-f]{8}$/u),
	publicKeyPEM: z.string().startsWith("-----BEGIN PUBLIC KEY-----"),
	/**
	 * The mailwoman major versions this key signs for.
	 */
	majorVersions: z.array(z.number().int().min(0)).min(1),
	status: z.enum([LicenseKeyStatus.Active, LicenseKeyStatus.Retired, LicenseKeyStatus.Revoked]),
})

export type LicenseSigningKey = z.infer<typeof SigningKeySchema>

/**
 * The schema of `trust-register.json`.
 */
export const TrustRegisterSchema = z.object({
	format: z.literal("mailwoman-trust-register/1"),
	license_keys: z.array(SigningKeySchema),
	provenance_keys: z.array(SigningKeySchema),
})

export type TrustRegister = z.infer<typeof TrustRegisterSchema>

// A module-level constant of a pure computation: the register is parsed once, at import,
// so a malformed register fails every importer at load rather than at the first verification.
const TRUST_REGISTER: TrustRegister = TrustRegisterSchema.parse(register)

/**
 * Every license signing key ever registered, with its current status.
 */
export const LICENSE_SIGNING_KEYS: readonly LicenseSigningKey[] = TRUST_REGISTER.license_keys

/**
 * Every provenance signing key ever registered, with its current status.
 */
export const PROVENANCE_SIGNING_KEYS: readonly LicenseSigningKey[] = TRUST_REGISTER.provenance_keys

/**
 * Key id → PEM public key for offline verification: every key in `keys` that's not revoked.
 */
export function trustMap(keys: readonly LicenseSigningKey[]): Readonly<Record<string, string>> {
	return Object.fromEntries(
		keys.filter((key) => key.status !== LicenseKeyStatus.Revoked).map((key) => [key.kid, key.publicKeyPEM])
	)
}

/**
 * The trust map for platform keys and training grants.
 */
export function trustedLicenseSigningKeys(): Readonly<Record<string, string>> {
	return trustMap(LICENSE_SIGNING_KEYS)
}

/**
 * The trust map for model provenance manifests.
 */
export function trustedProvenanceSigningKeys(): Readonly<Record<string, string>> {
	return trustMap(PROVENANCE_SIGNING_KEYS)
}
