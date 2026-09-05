/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"

import { type LicenseWorkerBindings, readEnv } from "#env"
import { signingSelfTest } from "#signing"

import { envWithSigningKey } from "./support/keys.ts"

const base = readEnv(env as unknown as LicenseWorkerBindings)

describe("the signing self-test", () => {
	it("reads mismatch when the configured kid is not an active entry of the shipped register, even for a key that matches it", async () => {
		// A test key is never in the register: the register is release-bound trust, and this is the property that keeps a
		// sandbox key out of production.
		const { env: worker, kid } = await envWithSigningKey(base)

		expect(await signingSelfTest(worker)).toMatchObject({
			status: "mismatch",
			kid,
			reason: expect.stringContaining("register"),
		})
	})

	it("reads mismatch for a registered kid whose private key does not sign for it", async () => {
		const { env: worker } = await envWithSigningKey(base)

		expect(await signingSelfTest({ ...worker, LICENSE_SIGNING_KID: "v9-ecec29be" })).toMatchObject({
			status: "mismatch",
			kid: "v9-ecec29be",
			reason: expect.stringContaining("does not sign"),
		})
	})

	it("reads mismatch for an unreadable key", async () => {
		expect(
			await signingSelfTest({ ...base, LICENSE_SIGNING_KID: "v9-ecec29be", LICENSE_SIGNING_KEY_PEM: "not a key" })
		).toMatchObject({ status: "mismatch" })
	})
})
