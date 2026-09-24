/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The config-root license files. `$public` reads `process.env` on every access, so the test points the config root and
 *   the key variable at a scratch directory with `vi.stubEnv` and the modules under test see it.
 */

import { statPath } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import {
	readConfiguredLicenseToken,
	readRefreshCredentials,
	writeLicenseKeyFile,
	writeRefreshCredentials,
} from "@mailwoman/core/license"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

describe("the config-root license files", () => {
	let scratch: Awaited<ReturnType<typeof temporaryDirectory>>

	beforeEach(async () => {
		scratch = await temporaryDirectory("license-key-file-")
		vi.stubEnv("MAILWOMAN_CONFIG_ROOT", scratch.path.toString())
		vi.stubEnv("MAILWOMAN_LICENSE_KEY", "")
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		await scratch[Symbol.asyncDispose]()
	})

	it("answers nothing when neither the variable nor the file is set", async () => {
		expect(await readConfiguredLicenseToken()).toBeNull()
	})

	it("reads the file when the variable is unset, and the variable first when both are set", async () => {
		await writeLicenseKeyFile("mwl1.file.token\n")

		await expect(readConfiguredLicenseToken()).resolves.toEqual({ token: "mwl1.file.token", source: "file" })

		vi.stubEnv("MAILWOMAN_LICENSE_KEY", "mwl1.env.token")

		await expect(readConfiguredLicenseToken()).resolves.toEqual({ token: "mwl1.env.token", source: "environment" })
	})

	it("writes the refresh credentials mode 0600 and reads them back; a missing file answers nothing", async () => {
		await expect(readRefreshCredentials()).resolves.toBeNull()

		const path = await writeRefreshCredentials({ lid: "lic_x", secret: "s".repeat(43) })
		const stats = await statPath(path)

		expect(stats.mode & 0o777).toBe(0o600)
		await expect(readRefreshCredentials()).resolves.toEqual({ lid: "lic_x", secret: "s".repeat(43) })
	})
})
