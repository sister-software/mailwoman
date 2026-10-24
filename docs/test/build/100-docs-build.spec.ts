/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build-health check. Runs the real production build (`docusaurus build`) and asserts it both
 *   succeeds and emits no warnings/errors. This includes Docusaurus's broken-anchor and broken-link warnings.
 *   Those warnings surface during static-site generation rather than during
 *   typecheck or bundling.
 *
 *   This runs as the Playwright `build` project (see playwright.config.mts), building into a throwaway
 *   dir so it never clobbers the `build/` output the webServer produces and serves to the browser
 *   specs. Skipped automatically in remote-smoke mode (`MAILWOMAN_DEMO_URL` set).
 */

import { runFile } from "@mailwoman/core/process"
import { expect, test } from "@playwright/test"
import { resolvePath } from "path-ts"
import { TextSpliterator } from "spliterator"

/**
 * Docs/ workspace root — this file lives at docs/test/build/.
 */
// `__dirname`, not `import.meta.url`: Playwright transpiles these specs for a package
// with no `"type": "module"`, so import.meta is a syntax error at load time.
// This was masked while the whole config failed to load.
// The file never got far enough to be parsed.
const DOCS_ROOT = resolvePath(__dirname, "../..")

// Not `childEnv` from @mailwoman/core: importing workspace TypeScript pulls Playwright's loader into
// the module graph. It handles neither `.ts`-extension imports nor the project references behind
// them. The helper is a spread over process.env. Playwright loads this spec outside the repo's helpers.
// oxlint-disable-next-line sister-software/no-process-globals -- see above
const processEnv = process.env

/**
 * Build into a throwaway dir rather than the workspace `build/`.
 *
 * The Playwright webServer serves `build/` for the browser specs.
 * A health-check build there would clobber the served site.
 *
 * The directory sits inside the docs workspace because the server bundle requires
 * its externals, such as `isomorphic-dompurify`, at render time.
 * Node resolves them from a `node_modules` directory above the bundle.
 * A directory under the system temp root has none above it.
 */
const CHECK_OUT_DIR = resolvePath(DOCS_ROOT, "build-check")

/**
 * Lines Docusaurus prints for build problems, as opposed to informational output.
 *
 * We scan combined stdout+stderr for these markers rather than relying solely on exit code,
 * because broken-link warnings (the most common docs regression) are emitted as
 * `[warning]` without failing the build by default.
 */
const PROBLEM_MARKERS = [/\[ERROR\]/, /\[WARNING\]/, /Broken link/i, /Error: /]

test.describe("docs build", () => {
	// A cold production build is minutes rather than seconds — the project-level
	// timeout (see config) covers it.
	// This is a belt-and-braces guard for the single test body.
	test.setTimeout(600_000)

	test("completes with no warnings or errors", async () => {
		let stdout: string
		let stderr: string
		let failed = false

		try {
			const result = await runFile("yarn", ["build", "--out-dir", CHECK_OUT_DIR], {
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

		const offending = TextSpliterator.from(combined)
			.filter((line) => PROBLEM_MARKERS.some((re) => re.test(line)))
			.toArray()

		expect(failed, `docusaurus build exited non-zero:\n${stderr}`).toBe(false)
		expect(offending, `build emitted warnings/errors:\n${offending.join("\n")}`).toEqual([])
	})
})
