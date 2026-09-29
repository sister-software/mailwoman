/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Integration test for `mailwoman skill install [--dest <dir>]`. It runs the compiled CLI and checks that the
 *   packaged Claude Code skill reaches `<dest>/.claude/skills/mailwoman/`. Cases cover the default destination,
 *   a second idempotent run, the explicit `--dest` override and reinstall removal of stale files.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { runFile } from "@mailwoman/core/process"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, test, vi } from "vitest"

import { mailwomanCLIPath } from "#cli/kit/metadata"
import { withCLISpawnLockAsync } from "#test-kit/cli-spawn-lock"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const CLI_PATH = await mailwomanCLIPath()
const hasCLICompiled = await pathExists(CLI_PATH)

/**
 * Wall-clock budget for a CLI spawn.
 * See the note in `geocode.test.ts`.
 *
 * A single spawn costs ~5.6 s, including 2.7 s of node boot.
 */
const CLI_SPAWN_TIMEOUT_MS = 45_000

/**
 * Per-test budget.
 *
 * Must exceed {@link CLI_SPAWN_TIMEOUT_MS} plus time queued on the spawn lock.
 */
const CLI_TEST_TIMEOUT_MS = 120_000

/**
 * Vitest's per-test budget for this whole file.
 *
 * Set the timeout at file scope because every test spawns the compiled CLI.
 * Startup takes seconds before assertions, then each test queues behind {@link withCLISpawnLockAsync}.
 *
 * A new test can omit its per-test annotation.
 * It would inherit the global 15s timeout.
 *
 * That timeout can kill the operation before it reports.
 * The failure then reports timeout without attribution.
 */
vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS })

describe.skipIf(!hasCLICompiled)("mailwoman skill install", () => {
	async function makeTempDir(prefix: string): Promise<PathBuilder> {
		return fixtures.use(await temporaryDirectory(prefix)).path
	}

	test("installs into <cwd>/.claude/skills/mailwoman/SKILL.md by default", async () => {
		const cwd = await makeTempDir("mw-skill-install-")

		await withCLISpawnLockAsync(() =>
			runFile(process.execPath, [CLI_PATH, "skill", "install"], {
				cwd,
				encoding: "utf8",
				timeout: CLI_SPAWN_TIMEOUT_MS,
			})
		)

		const skillPath = cwd(".claude", "skills", "mailwoman", "SKILL.md")

		expect(await pathExists(skillPath)).toBe(true)
		expect(await readLocalTextFile(skillPath)).toMatch(/^---\nname: mailwoman\n/)
	})

	test("second run is idempotent — overwrites cleanly with no error", async () => {
		const cwd = await makeTempDir("mw-skill-install-idempotent-")

		const spawn = () =>
			withCLISpawnLockAsync(() =>
				runFile(process.execPath, [CLI_PATH, "skill", "install"], {
					cwd,
					encoding: "utf8",
					timeout: CLI_SPAWN_TIMEOUT_MS,
				})
			)

		// The old sync form ran `spawn()` and then re-ran it inside `expect(spawn).not.toThrow()`.
		// The second run is the idempotence assertion.
		// An async rejection is invisible to that form, so await both runs:
		// either one failing rejects this test.
		await spawn()
		await spawn()

		const skillPath = cwd(".claude", "skills", "mailwoman", "SKILL.md")

		expect(await pathExists(skillPath)).toBe(true)
	})

	test("--dest <dir> installs there instead of cwd", async () => {
		const cwd = await makeTempDir("mw-skill-install-cwd-")
		const dest = await makeTempDir("mw-skill-install-dest-")

		await withCLISpawnLockAsync(() =>
			runFile(process.execPath, [CLI_PATH, "skill", "install", "--dest", dest], {
				cwd,
				encoding: "utf8",
				timeout: CLI_SPAWN_TIMEOUT_MS,
			})
		)

		expect(await pathExists(dest(".claude", "skills", "mailwoman", "SKILL.md"))).toBe(true)
		expect(await pathExists(cwd(".claude"))).toBe(false)
	})

	test("a stale file left over from an older shipped skill is removed, not merged", async () => {
		const cwd = await makeTempDir("mw-skill-install-stale-")
		const skillDir = cwd(".claude", "skills", "mailwoman")
		const staleFile = skillDir("stale-reference.md")

		// Plant a file that a hypothetical older install left behind and the current
		// shipped skill no longer includes.
		// A merge-only copy (bare cpSync) would leave this in place forever.
		await makeDirectories(skillDir)
		await writeLocalTextFile("belongs to an older skill version; must not survive a reinstall", staleFile)

		await withCLISpawnLockAsync(() =>
			runFile(process.execPath, [CLI_PATH, "skill", "install"], {
				cwd,
				encoding: "utf8",
				timeout: CLI_SPAWN_TIMEOUT_MS,
			})
		)

		expect(await pathExists(staleFile)).toBe(false)
		expect(await pathExists(skillDir("SKILL.md"))).toBe(true)
	})
})
