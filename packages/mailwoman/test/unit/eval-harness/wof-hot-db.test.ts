/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { join } from "@mailwoman/platform/path"
import { resolveWOFHotDB } from "mailwoman/eval-harness/wof-hot-db"
import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("resolveWOFHotDB", () => {
	it("uses the caller's stage directory when the environment variable is absent", () => {
		vi.stubEnv("MAILWOMAN_WOF_HOT_DB", undefined)

		expect(resolveWOFHotDB("/tmp/demo-stage")).toBe(join("/tmp/demo-stage", "wof-hot.db"))
	})

	it("treats an empty environment variable as unset", () => {
		vi.stubEnv("MAILWOMAN_WOF_HOT_DB", "")

		expect(resolveWOFHotDB("/tmp/demo-stage")).toBe(join("/tmp/demo-stage", "wof-hot.db"))
	})

	it("uses a non-empty environment override", () => {
		vi.stubEnv("MAILWOMAN_WOF_HOT_DB", "/var/lib/mailwoman/hot.db")

		expect(resolveWOFHotDB("/tmp/demo-stage")).toBe("/var/lib/mailwoman/hot.db")
	})
})
