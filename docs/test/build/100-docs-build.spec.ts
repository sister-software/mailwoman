/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build-health gate. Runs the real production build (`docusaurus build`) and asserts it both
 *   succeeds AND emits no warnings/errors — most importantly Docusaurus's broken-anchor /
 *   broken-link warnings, which only surface during the static-site-generation phase, not during
 *   typecheck or bundling.
 *
 *   This runs as the Playwright `build` project (see playwright.config.ts), building into a throwaway
 *   dir so it never clobbers the `build/` output the webServer produces and serves to the browser
 *   specs. Skipped automatically in remote-smoke mode (`MAILWOMAN_DEMO_URL` set).
 */

import { execFile } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { childEnv } from "@mailwoman/core/scripting/utils"
import { expect, test } from "@playwright/test"

const execFileAsync = promisify(execFile)

/** Docs/ workspace root — this file lives at docs/test/build/. */
const DOCS_ROOT = fileURLToPath(new URL("../..", import.meta.url))

/**
 * Build into a throwaway dir, not the workspace `build/`. The Playwright webServer serves `build/` for the browser
 * specs; building the health check there too would clobber the served site.
 */
const CHECK_OUT_DIR = join(tmpdir(), "mailwoman-docs-build-check")

/**
 * Lines Docusaurus prints for genuine problems. We scan combined stdout+stderr for these markers rather than relying
 * solely on exit code, because broken-link warnings (the most common docs regression) are emitted as `[WARNING]`
 * without failing the build by default.
 */
const PROBLEM_MARKERS = [/\[ERROR\]/, /\[WARNING\]/, /Broken link/i, /Error: /]

test.describe("docs build", () => {
	// A cold production build is minutes, not seconds — the project-level timeout (see config) covers
	// it; this is a belt-and-braces guard for the single test body.
	test.setTimeout(600_000)

	test("completes with no warnings or errors", async () => {
		let stdout = ""
		let stderr = ""
		let failed = false

		try {
			const result = await execFileAsync("yarn", ["build", "--out-dir", CHECK_OUT_DIR], {
				cwd: DOCS_ROOT,
				maxBuffer: 64 * 1024 * 1024,
				env: childEnv({ CI: "true" }),
			})
			stdout = result.stdout
			stderr = result.stderr
		} catch (error) {
			failed = true
			const e = error as { stdout?: string; stderr?: string; message?: string }
			stdout = e.stdout ?? ""
			stderr = e.stderr ?? e.message ?? ""
		}

		const combined = `${stdout}\n${stderr}`
		const offending = combined.split("\n").filter((line) => PROBLEM_MARKERS.some((re) => re.test(line)))

		expect(failed, `docusaurus build exited non-zero:\n${stderr}`).toBe(false)
		expect(offending, `build emitted warnings/errors:\n${offending.join("\n")}`).toEqual([])
	})
})
