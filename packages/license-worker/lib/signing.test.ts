/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { readEnv } from "#env"
import { signingSelfTest } from "#signing"
import { envWithSigningKey } from "#test/support/keys"

const base = readEnv(env)

describe("the signing self-test", () => {
	it("trusts the worker's own key in a sandbox when its public half digests to the configured kid, and reads mismatch for the same key in live mode", async () => {
		// A test key stays out of the register.
		// The register is release-bound trust.
		// This keeps a sandbox key out of production.
		// In a sandbox the worker vouches for itself, so an end-to-end run can mint.
		const { env: worker, kid } = await envWithSigningKey(base)

		await expect(signingSelfTest(worker)).resolves.toEqual({ status: "ok", kid, trust: "sandbox", reason: null })

		await expect(signingSelfTest({ ...worker, liveMode: true })).resolves.toMatchObject({
			status: "mismatch",
			kid,
			reason: expect.stringContaining("register"),
		})

		await expect(signingSelfTest({ ...worker, LICENSE_SIGNING_KID: "v9-00000000" })).resolves.toMatchObject({
			status: "mismatch",
			kid: "v9-00000000",
			reason: expect.stringContaining(`signs for ${kid}`),
		})
	})

	it("reads mismatch for a registered kid whose private key does not sign for it", async () => {
		const { env: worker } = await envWithSigningKey(base)

		await expect(signingSelfTest({ ...worker, LICENSE_SIGNING_KID: "v9-ecec29be" })).resolves.toMatchObject({
			status: "mismatch",
			kid: "v9-ecec29be",
			reason: expect.stringContaining("does not sign"),
		})
	})

	it("reads mismatch for an unreadable key", async () => {
		await expect(
			signingSelfTest({ ...base, LICENSE_SIGNING_KID: "v9-ecec29be", LICENSE_SIGNING_KEY_PEM: "not a key" })
		).resolves.toMatchObject({ status: "mismatch" })
	})
})
