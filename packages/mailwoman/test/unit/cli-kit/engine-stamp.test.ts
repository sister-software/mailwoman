/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { printLicenseNotice, resolveEngineStamp } from "mailwoman/cli-kit/engine-stamp"
import { readMailwomanManifest } from "mailwoman/cli-kit/metadata"
import { describe, expect, it } from "vitest"

describe("resolveEngineStamp", () => {
	it("stamps the package's own version and a branch of its own license expression", async () => {
		const manifest = await readMailwomanManifest()
		const { stamp } = await resolveEngineStamp()

		expect(stamp.name).toBe("mailwoman")
		expect(stamp.version).toBe(manifest.version)
		expect(manifest.license?.split(/\s+OR\s+/u)).toContain(stamp.license)
		expect(stamp.license_url.endsWith("/license")).toBe(true)
	})

	it("answers the same object on every call", async () => {
		const first = await resolveEngineStamp()
		const second = await resolveEngineStamp()

		expect(second).toBe(first)
	})
})

describe("printLicenseNotice", () => {
	it("writes the two notice lines for the open-source branch and nothing for the commercial one", () => {
		const open = {
			stamp: {
				name: "mailwoman" as const,
				version: "0.0.0",
				license: "AGPL-3.0-only",
				license_url: "https://mailwoman.ai/license",
				notice: "x",
			},
		}

		const commercial = {
			stamp: {
				name: "mailwoman" as const,
				version: "0.0.0",
				license: "LicenseRef-Commercial",
				license_url: "https://mailwoman.ai/license",
			},
		}

		const written: string[] = []

		printLicenseNotice(open, (line) => written.push(line))
		expect(written).toHaveLength(2)
		expect(written[1]).toContain("https://mailwoman.ai/license")

		written.length = 0
		printLicenseNotice(commercial, (line) => written.push(line))
		expect(written).toEqual([])
	})
})
