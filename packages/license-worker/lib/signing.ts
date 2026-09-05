/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Prove the configured private key is the one the configured kid names, and that the kid is an `active` entry of the
 *   register this build ships. A worker whose key the shipped release does not trust would mint tokens no installation
 *   accepts, so it must refuse to mint at all. A sandbox key is never in the register, which is why a sandbox deploy
 *   reads `mismatch` here by design and the route tests inject the status instead.
 */

import { encodeLicenseKey, verifyLicenseKey } from "@mailwoman/core/license/key"
import { LICENSE_SIGNING_KEYS, LicenseKeyStatus } from "@mailwoman/core/license/register"

import type { LicenseWorkerEnv } from "#env"

export type SigningStatus = "ok" | "mismatch"

export interface SigningSelfTest {
	status: SigningStatus
	kid: string
	reason?: string
}

export async function signingSelfTest(env: LicenseWorkerEnv): Promise<SigningSelfTest> {
	const entry = LICENSE_SIGNING_KEYS.find((key) => key.kid === env.LICENSE_SIGNING_KID)

	if (!entry || entry.status !== LicenseKeyStatus.Active) {
		return {
			status: "mismatch",
			kid: env.LICENSE_SIGNING_KID,
			reason: `key id ${env.LICENSE_SIGNING_KID} is not an active entry of the shipped register`,
		}
	}

	try {
		const probe = await encodeLicenseKey(
			{
				v: 1,
				kid: entry.kid,
				licensee: "self-test",
				issued: "2026-01-01",
				scope: "all",
				terms: "LicenseRef-Commercial",
			},
			env.LICENSE_SIGNING_KEY_PEM
		)

		const verified = await verifyLicenseKey(probe, {
			trustedKeys: { [entry.kid]: entry.publicKeyPEM },
			now: new Date("2026-01-02T00:00:00Z"),
		})

		if (verified.status !== "valid") {
			return { status: "mismatch", kid: entry.kid, reason: `the private key does not sign for ${entry.kid}` }
		}

		return { status: "ok", kid: entry.kid }
	} catch (error) {
		return {
			status: "mismatch",
			kid: env.LICENSE_SIGNING_KID,
			reason: `the private key does not sign for ${entry.kid}: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}
