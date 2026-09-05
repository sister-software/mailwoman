/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `serveNode` under a cluster worker, the shape `mailwoman serve` runs in. The in-process test in `index.test.ts`
 *   never exercises Node's cluster child, which calls `server.address()` on the listening server; this one forks the
 *   fixture as a real process and reads what the primary reports.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { expect, test } from "vitest"

const fixture = resolvePackagePath("@mailwoman/api-kit", "test", "fixtures", "cluster-serve.ts")

test("serveNode: a cluster worker reaches listening and reports its port", async () => {
	// A non-zero exit is the failure under test, so its output is the evidence rather than a thrown error.
	const { stdout, stderr } = await runFile(process.execPath, [fixture], {
		env: childEnv({ NODE_NO_WARNINGS: "1" }),
	}).catch((error: unknown) => {
		if (isProcessError(error)) return error

		throw error
	})

	expect(stderr, stderr).not.toContain("TypeError")
	expect(stdout).toMatch(/^LISTENING \d+\n$/u)
})
