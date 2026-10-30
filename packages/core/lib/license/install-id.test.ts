/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { temporaryDirectory } from "#fs/temporary"
import { installationIDFilePath, readInstallationID, readOrMintInstallationID } from "#license"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

describe("the installation id", () => {
	let scratch: Awaited<ReturnType<typeof temporaryDirectory>>

	beforeEach(async () => {
		scratch = await temporaryDirectory("license-install-id-")
		vi.stubEnv("MAILWOMAN_CONFIG_ROOT", scratch.path.toString())
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		await scratch[Symbol.asyncDispose]()
	})

	it("reads null before the first mint", async () => {
		await expect(readInstallationID()).resolves.toBeNull()
	})

	it("mints a UUID once under the config root and reads the same id after", async () => {
		const first = await readOrMintInstallationID()

		expect(first).toMatch(UUID)
		expect(installationIDFilePath().toString().startsWith(scratch.path.toString())).toBe(true)
		await expect(readOrMintInstallationID()).resolves.toBe(first)
		await expect(readInstallationID()).resolves.toBe(first)
	})
})
