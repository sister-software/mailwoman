/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Under Node every logger level writes to stderr, so a command whose stdout is data stays parseable.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { spawnProcessSync } from "@mailwoman/core/process"
import { describe, expect, it } from "vitest"

const SCRIPT = `
import { ConsoleLogger, createConsoleLogger } from "@mailwoman/core/logging"
ConsoleLogger.info("info-line")
ConsoleLogger.debug("debug-line")
createConsoleLogger("client").debug("GET https://example.test/")
console.log("data-line")
`

describe("diagnostics stream", () => {
	it("writes every level to stderr and leaves stdout to the data", () => {
		const result = spawnProcessSync("node", ["--input-type=module", "-e", SCRIPT], {
			cwd: String(resolvePackagePath("@mailwoman/core")),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		})

		expect(result.status).toBe(0)
		expect(result.stdout).toBe("data-line\n")
		expect(result.stderr).toContain("[INFO] : info-line")
		expect(result.stderr).toContain("[DEBUG] : debug-line")
		expect(result.stderr).toContain("[DEBUG] (client): GET https://example.test/")
	})
})
