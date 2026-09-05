/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Prove the configured private key is the one the configured kid names, and that something trusts that kid. In
 *   production the shipped register is the only authority: a worker whose key the installed release does not trust
 *   would mint tokens no installation accepts, so it must refuse to mint at all. In a sandbox no shipped release trusts
 *   the key by design, so the worker trusts its own: the public half is derived from the private key and must digest
 *   to the configured kid, which is what a sandbox end-to-end run verifies tokens against.
 */

import { publicKeyFromPrivateKey } from "@mailwoman/core/crypto/ed25519"
import { encodeLicenseKey, licenseKeyID, verifyLicenseKey } from "@mailwoman/core/license/key"
import { LICENSE_SIGNING_KEYS, LicenseKeyStatus } from "@mailwoman/core/license/register"

import type { LicenseWorkerEnv } from "#env"

export type SigningStatus = "ok" | "mismatch"

/**
 * Who trusts the key: the shipped register, or only this worker because the environment is a sandbox.
 */
export type SigningTrust = "register" | "sandbox"

export interface SigningSelfTest {
	status: SigningStatus
	kid: string
	trust?: SigningTrust
	reason?: string
}

/**
 * A key id as `licenseKeyID` mints it: the major version it belongs to, then eight hex digits of the key's digest.
 */
const KEY_ID_SHAPE = /^v(?<major>\d+)-[0-9a-f]{8}$/u

type TrustedPublicKey = { publicKeyPEM: string; trust: SigningTrust } | { reason: string }

async function trustedPublicKey(env: LicenseWorkerEnv): Promise<TrustedPublicKey> {
	const kid = env.LICENSE_SIGNING_KID
	const entry = LICENSE_SIGNING_KEYS.find((key) => key.kid === kid)

	if (entry) {
		if (entry.status !== LicenseKeyStatus.Active) {
			return { reason: `key id ${kid} is a ${entry.status} entry of the shipped register` }
		}

		return { publicKeyPEM: entry.publicKeyPEM, trust: "register" }
	}

	if (env.liveMode) return { reason: `key id ${kid} is not an active entry of the shipped register` }

	const major = KEY_ID_SHAPE.exec(kid)?.groups?.major

	if (!major) return { reason: `key id ${kid} is not of the form v<major>-<eight hex digits>` }

	let publicKeyPEM: string

	try {
		publicKeyPEM = await publicKeyFromPrivateKey(env.LICENSE_SIGNING_KEY_PEM)
	} catch (error) {
		return { reason: `the private key cannot be read: ${error instanceof Error ? error.message : String(error)}` }
	}

	const derived = await licenseKeyID(publicKeyPEM, Number(major))

	if (derived !== kid) return { reason: `the private key signs for ${derived}, not ${kid}` }

	return { publicKeyPEM, trust: "sandbox" }
}

export async function signingSelfTest(env: LicenseWorkerEnv): Promise<SigningSelfTest> {
	const kid = env.LICENSE_SIGNING_KID
	const trusted = await trustedPublicKey(env)

	if ("reason" in trusted) return { status: "mismatch", kid, reason: trusted.reason }

	try {
		const probe = await encodeLicenseKey(
			{
				v: 1,
				kid,
				licensee: "self-test",
				issued: "2026-01-01",
				scope: "all",
				terms: "LicenseRef-Commercial",
			},
			env.LICENSE_SIGNING_KEY_PEM
		)

		const verified = await verifyLicenseKey(probe, {
			trustedKeys: { [kid]: trusted.publicKeyPEM },
			now: new Date("2026-01-02T00:00:00Z"),
		})

		if (verified.status !== "valid") {
			return { status: "mismatch", kid, reason: `the private key does not sign for ${kid}` }
		}

		return { status: "ok", kid, trust: trusted.trust }
	} catch (error) {
		return {
			status: "mismatch",
			kid,
			reason: `the private key does not sign for ${kid}: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}
