/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A signing pair minted per test run, and an env whose secret and kid match it. The pair is never in the shipped
 *   register, which is the property the signing self-test refuses on: a route test that needs a minted token injects
 *   `signingStatus: () => "ok"` through the app's dependencies and verifies against `publicKeyPEM` here.
 */

import { generateLicenseSigningKeyPair, licenseKeyID } from "@mailwoman/core/license/key"

import type { LicenseWorkerEnv } from "#env"

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
