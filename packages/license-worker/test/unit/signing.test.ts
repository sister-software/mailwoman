/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readEnv } from "@mailwoman/license-worker/env"
import { signingSelfTest } from "@mailwoman/license-worker/signing"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { envWithSigningKey } from "../support/keys.ts"

const base = readEnv(env)

describe("the signing self-test", () => {
	it("trusts the worker's own key in a sandbox when its public half digests to the configured kid, and reads mismatch for the same key in live mode", async () => {
		// A test key is never in the register: the register is release-bound trust, and that is what keeps a sandbox key
		// out of production. In a sandbox the worker vouches for itself, so an end-to-end run can mint.
		const { env: worker, kid } = await envWithSigningKey(base)

		expect(await signingSelfTest(worker)).toEqual({ status: "ok", kid, trust: "sandbox" })

		expect(await signingSelfTest({ ...worker, liveMode: true })).toMatchObject({
			status: "mismatch",
			kid,
			reason: expect.stringContaining("register"),
		})

		expect(await signingSelfTest({ ...worker, LICENSE_SIGNING_KID: "v9-00000000" })).toMatchObject({
			status: "mismatch",
			kid: "v9-00000000",
			reason: expect.stringContaining(`signs for ${kid}`),
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
