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
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { expect, test } from "@playwright/test"
import { TextSpliterator } from "spliterator"

const execFileAsync = promisify(execFile)

/**
 * Docs/ workspace root — this file lives at docs/test/build/.
 */
// `__dirname`, not `import.meta.url`: Playwright transpiles these specs for a package with no
// `"type": "module"`, so import.meta is a syntax error at load time. This was masked while the whole
// config failed to load — the file never got far enough to be parsed.
const DOCS_ROOT = resolve(__dirname, "../..")

// Not `childEnv` from @mailwoman/core: importing workspace TypeScript pulls Playwright's loader into
// the module graph, and it handles neither `.ts`-extension imports nor the project references behind
// them. The helper is a spread over process.env; Playwright loads this spec outside the repo's helpers.
// oxlint-disable-next-line sister-software/no-process-globals -- see above
const processEnv = process.env

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
		let stdout: string
		let stderr: string
		let failed = false

		try {
			const result = await execFileAsync("yarn", ["build", "--out-dir", CHECK_OUT_DIR], {
				cwd: DOCS_ROOT,
				maxBuffer: 64 * 1024 * 1024,
				env: { ...processEnv, CI: "true" },
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
		const offending = [...TextSpliterator.from(combined)].filter((line) => PROBLEM_MARKERS.some((re) => re.test(line)))

		expect(failed, `docusaurus build exited non-zero:\n${stderr}`).toBe(false)
		expect(offending, `build emitted warnings/errors:\n${offending.join("\n")}`).toEqual([])
	})
})
