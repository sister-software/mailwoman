/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   {@linkcode lazyComponent}'s REJECTION contract. The happy path is covered wherever the deferred component itself
 *   is (`geocode --debug`); this file exists for the branch that only shows up when an import fails, which is the
 *   branch nothing else would notice was missing.
 *
 *   It runs the wrapper in a subprocess against real Ink, the same posture as `test/benchmark-flag.test.ts`, for one
 *   reason: the contract INCLUDES `process.exit(1)`, and a helper that exits cannot be asserted in-process without
 *   stubbing the very thing under test. `node --input-type=module -e` resolves bare specifiers against the cwd, so the
 *   harness reaches the workspace's own `mailwoman/cli-kit` and `ink`.
 *
 *   STDOUT-vs-STDERR is the discriminator that makes these assertions worth anything. An unhandled rejection also
 *   exits 1 and also prints the message — but node's default handler writes it to STDERR. A message on stdout with an
 *   empty stderr is proof it went through Ink's `<Text color="red">` frame instead.
 */

import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

/**
 * Render a `lazyComponent` whose loader rejects with `thrown`, through a real interactive-mode Ink instance.
 */
function harness(thrown: string): string {
	return `
		import { createElement } from "react"
		import { render } from "ink"
		import { CommandError, lazyComponent } from "mailwoman/cli-kit"

		const Boom = lazyComponent(async () => {
			throw ${thrown}
		})

		render(createElement(Boom, {}))
	`
}

async function runHarness(thrown: string): Promise<{ code: number | undefined; stdout: string; stderr: string }> {
	try {
		const result = await runFile(process.execPath, ["--input-type=module", "-e", harness(thrown)], {
			cwd: repoRootPath(),
			env: childEnv(),
		})

		return { code: 0, stdout: result.stdout, stderr: result.stderr }
	} catch (thrownError) {
		const error = thrownError as Error & { stdout?: string; stderr?: string; code?: number }

		return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }
	}
}

describe("lazyComponent — a rejected import", () => {
	test("renders the failure and exits 1 rather than dying on an unhandled rejection", async () => {
		const { code, stdout, stderr } = await runHarness(`new Error("Cannot find package 'not-installed-peer'")`)

		expect(code).toBe(1)
		expect(stdout).toMatch(/Cannot find package 'not-installed-peer'/u)
		// Nothing on stderr: node's unhandled-rejection handler never ran.
		expect(stderr).toBe("")
	}, 30_000)

	test("renders a CommandError as guidance, with no stack", async () => {
		const { code, stdout, stderr } = await runHarness(
			`new CommandError("geocode --debug requires the optional @mailwoman/map-tui package")`
		)

		expect(code).toBe(1)
		expect(stdout).toMatch(/geocode --debug requires the optional @mailwoman\/map-tui package/u)
		// Expected command guidance omits a stack; unexpected errors retain theirs.
		expect(stdout).not.toMatch(/\s+at\s/u)
		expect(stderr).toBe("")
	}, 30_000)
})
