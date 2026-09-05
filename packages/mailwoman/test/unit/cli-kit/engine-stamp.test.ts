/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { resolveEngineStamp } from "mailwoman/cli-kit/engine-stamp"
import { readMailwomanManifest } from "mailwoman/cli-kit/metadata"
import { describe, expect, it } from "vitest"

describe("resolveEngineStamp", () => {
	it("stamps the package's own version and a branch of its own license expression", async () => {
		const manifest = await readMailwomanManifest()
		const { stamp } = await resolveEngineStamp()

		expect(stamp.name).toBe("mailwoman")
		expect(stamp.version).toBe(manifest.version)
		expect(manifest.license.split(/\s+OR\s+/u)).toContain(stamp.license)
		expect(stamp.license_url.endsWith("/license")).toBe(true)
	})

	it("answers the same object on every call", async () => {
		const first = await resolveEngineStamp()
		const second = await resolveEngineStamp()

		expect(second).toBe(first)
	})
})
