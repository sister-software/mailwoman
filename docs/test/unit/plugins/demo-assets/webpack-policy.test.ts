/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { configureDemoWebpack } from "@mailwoman/docs/plugins/demo-assets/webpack-policy"
import { buildWorkspaceAliases } from "@mailwoman/docs/plugins/demo-assets/workspace-aliases"
import { resolve } from "@mailwoman/platform/path"
import { describe, expect, test } from "vitest"

const docsDir = resolve(import.meta.dirname, "../../../..")

describe("docs webpack policy", () => {
	test("places browser-safe leaf aliases before their Node-backed barrels", () => {
		const keys = Object.keys(buildWorkspaceAliases())

		expect(keys.indexOf("@mailwoman/core/resources/whosonfirst/specificity")).toBeLessThan(
			keys.indexOf("@mailwoman/core/resources")
		)
	})

	test("routes both public and private neural runner specifiers to the browser implementation for SSR", () => {
		const config = configureDemoWebpack({ cache: false }, true, docsDir)
		const aliases = config.resolve?.alias as Record<string, string>

		expect(aliases["#onnx-runner"]).toMatch(/onnx-runner-browser[.]ts$/)
		expect(aliases["@mailwoman/neural/onnx-runner"]).toBe(aliases["#onnx-runner"])
	})
})
