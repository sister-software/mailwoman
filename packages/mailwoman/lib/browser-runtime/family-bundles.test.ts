/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it, vi } from "vitest"

import { FamilyBundles } from "#browser-runtime/family-bundles"
import type { ReleaseInfo, ReleasesManifest } from "#browser-runtime/manifest"

const CJK_RELEASE: ReleaseInfo = {
	version: "v0.0.3",
	label: "v0.0.3",
	description: "the character family",
	modelSize: "30 MB",
	tokenizerVocab: 4451,
	steps: 8000,
	hasFST: false,
	hasWOFDB: true,
	encoder: "char",
	requiresRuntime: ["char_encoder"],
}

const CJK_MANIFEST: ReleasesManifest = { locale: "cjk", defaultVersion: "v0.0.3", releases: [CJK_RELEASE] }

describe("FamilyBundles", () => {
	it("routes Japanese, Chinese and Korean input to the character family and leaves Latin input with the base", () => {
		const bundles = new FamilyBundles<string>({ load: async () => "bundle" })

		expect(bundles.familyFor("〒150-0043 東京都渋谷区道玄坂1丁目")).toBe("cjk")
		expect(bundles.familyFor("渋谷駅")).toBe("cjk")
		expect(bundles.familyFor("北京市朝阳区建国路1号")).toBe("cjk")
		expect(bundles.familyFor("서울특별시 중구 세종대로 110")).toBe("cjk")
		expect(bundles.familyFor("1600 Pennsylvania Ave NW, Washington, DC 20500")).toBeNull()
		expect(bundles.familyFor("Shibuya Station, Tokyo")).toBeNull()
	})

	it("loads a family's default release once and shares it across inputs", async () => {
		const load = vi.fn(async (family: string, release: ReleaseInfo) => `${family}@${release.version}`)
		const fetchManifest = vi.fn(async () => CJK_MANIFEST)
		const bundles = new FamilyBundles<string>({ fetchManifest, load })

		const [first, second] = await Promise.all([bundles.forInput("渋谷駅"), bundles.forInput("東京都渋谷区")])

		expect(first).toBe("cjk@v0.0.3")
		expect(second).toBe("cjk@v0.0.3")
		expect(fetchManifest).toHaveBeenCalledTimes(1)
		expect(load).toHaveBeenCalledTimes(1)
		expect(load).toHaveBeenCalledWith("cjk", CJK_RELEASE)
		expect(await bundles.forInput("Shibuya Station, Tokyo")).toBeNull()
	})

	it("answers null for a family without a published manifest and loads no bundle", async () => {
		const load = vi.fn(async () => "bundle")
		const bundles = new FamilyBundles<string>({ fetchManifest: async () => null, load })

		expect(await bundles.ensure("cjk")).toBeNull()
		expect(load).not.toHaveBeenCalled()
	})

	it("forgets a failed load so the next input retries, and disposes every loaded bundle", async () => {
		let attempts = 0

		const load = vi.fn(async () => {
			attempts++

			if (attempts === 1) throw new Error("network")

			return "bundle"
		})

		const dispose = vi.fn()
		const bundles = new FamilyBundles<string>({ fetchManifest: async () => CJK_MANIFEST, load, dispose })

		await expect(bundles.ensure("cjk")).rejects.toThrow("network")
		expect(await bundles.ensure("cjk")).toBe("bundle")
		expect(load).toHaveBeenCalledTimes(2)

		await bundles.dispose()

		expect(dispose).toHaveBeenCalledWith("bundle")
		expect(load).toHaveBeenCalledTimes(2)

		expect(await bundles.ensure("cjk")).toBe("bundle")
		expect(load).toHaveBeenCalledTimes(3)
	})
})
