// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A signing pair minted per test run and an environment whose secret and `kid` match it.
 *   The shipped register excludes this pair, as the signing self-test requires.
 *   A route test that needs a minted token injects
 *   `signingStatus: () => "ok"` through the app's dependencies and verifies against `publicKeyPEM` here.
 */

import { generateLicenseSigningKeyPair, licenseKeyID } from "@mailwoman/core/license/key"
import type { LicenseWorkerEnv } from "@mailwoman/license-worker/env"

export interface SigningFixture {
	env: LicenseWorkerEnv
	publicKeyPEM: string
	kid: string
}

export async function envWithSigningKey(base: LicenseWorkerEnv): Promise<SigningFixture> {
	const pair = await generateLicenseSigningKeyPair()
	const kid = await licenseKeyID(pair.publicKeyPEM, 9)

	return {
		env: { ...base, LICENSE_SIGNING_KEY_PEM: pair.privateKeyPEM, LICENSE_SIGNING_KID: kid },
		publicKeyPEM: pair.publicKeyPEM,
		kid,
	}
}
