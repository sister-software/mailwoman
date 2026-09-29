/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The test runs in a subprocess against real Ink because the interface calls `process.exit(1)`.
 *   It strips ANSI codes before checking stdout and stderr, so colour cannot make a negative match pass.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { stripAnsi } from "mailwoman/cli-kit"
import { describe, expect, test } from "vitest"

function harness(thrown: string): string {
	return `
		import { createElement } from "react"
		import { render } from "ink"
		import { CommandError } from "@mailwoman/core/scripting/command"
		import { lazyComponent } from "mailwoman/cli-kit"

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

		return { code: 0, stdout: stripAnsi(result.stdout), stderr: stripAnsi(result.stderr) }
	} catch (thrownError) {
		const error = thrownError as Error & { stdout?: string; stderr?: string; code?: number }

		return { code: error.code, stdout: stripAnsi(error.stdout ?? ""), stderr: stripAnsi(error.stderr ?? "") }
	}
}

describe("lazyComponent — a rejected import", () => {
	test("renders the failure and exits 1 rather than dying on an unhandled rejection", async () => {
		const { code, stdout, stderr } = await runHarness(`new Error("Cannot find package 'not-installed-peer'")`)

		expect(code).toBe(1)
		expect(stdout).toMatch(/Cannot find package 'not-installed-peer'/u)
		expect(stderr).toBe("")
	}, 30_000)

	test("renders a CommandError as guidance, with no stack", async () => {
		const { code, stdout, stderr } = await runHarness(
			`new CommandError("geocode --debug requires the optional @mailwoman/map-tui package")`
		)

		expect(code).toBe(1)
		expect(stdout).toMatch(/geocode --debug requires the optional @mailwoman\/map-tui package/u)
		// Expected command guidance omits a stack.
		// Unexpected errors retain theirs.
		expect(stdout).not.toMatch(/\s+at\s/u)
		expect(stderr).toBe("")
	}, 30_000)
})
