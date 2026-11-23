// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The well-known JSON on mailwoman.post that publishes the license signing keys.
 *
 *   The keys themselves live in `@mailwoman/license/product/trust`, which reads the
 *   one trust register the TypeScript and Rust verifiers share.
 *   `mailwoman license register --write` regenerates the well-known file from it, and the
 *   `license-register` health check reports a mismatch between the register and the generated file.
 */

import { LICENSE_SIGNING_KEYS, type LicenseKeyStatus } from "@mailwoman/license/product/trust"

/**
 * The shape of the well-known file at `/.well-known/mailwoman/license-keys.json`.
 */
export interface PublishedLicenseKeys {
	format: "mailwoman-license-keys/1"
	$comment: string
	keys: Array<{
		kid: string
		algorithm: "Ed25519"
		publicKey: string
		majorVersions: number[]
		status: LicenseKeyStatus
	}>
}

const WELL_KNOWN_COMMENT =
	"The public halves of the commercial license signing keys, by key id, with each key's status. `mailwoman doctor --online` and `mailwoman license verify --online` read this to confirm a configured key's id is still active; offline verification uses the same keys shipped in @mailwoman/license/product/trust. Derived from packages/license/lib/product/trust-register.json by `mailwoman license register --write`; edit the register, not this file."

export function publishedLicenseKeys(): PublishedLicenseKeys {
	return {
		format: "mailwoman-license-keys/1",
		$comment: WELL_KNOWN_COMMENT,
		keys: LICENSE_SIGNING_KEYS.map((key) => ({
			kid: key.kid,
			algorithm: "Ed25519",
			publicKey: key.publicKeyPEM,
			majorVersions: [...key.majorVersions],
			status: key.status,
		})),
	}
}
