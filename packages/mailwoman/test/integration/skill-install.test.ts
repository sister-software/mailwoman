/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Integration test for `mailwoman skill install [--dest <dir>]` (#task-8): spawns the compiled CLI
 *   and asserts it copies the packaged Claude Code skill (`skills/mailwoman/`, shipped inside this
 *   package) into `<dest>/.claude/skills/mailwoman/`. Covers the default (cwd-rooted) destination, a
 *   second idempotent run, the explicit `--dest` override, and the clean-slate reinstall (a stale file
 *   a newer shipped skill dropped must be REMOVED, not left behind by a merge-only copy — the finding
 *   the task review caught: `cpSync` alone never deletes).
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { withCLISpawnLockAsync } from "mailwoman/test-kit/cli-spawn-lock"
import { join } from "path-ts"
import { afterAll, describe, expect, test, vi } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const CLI_PATH = workspacePath("mailwoman", "out", "cli.js")
const hasCLICompiled = await pathExists(CLI_PATH)

/**
 * Wall-clock budget for a CLI spawn — see the note in `geocode.test.ts`. A single spawn costs ~5.6 s, 2.7 s of it node
 * boot alone.
 */
const CLI_SPAWN_TIMEOUT_MS = 45_000

/**
 * Per-test budget. Must exceed {@link CLI_SPAWN_TIMEOUT_MS} plus time queued on the spawn lock.
 */
const CLI_TEST_TIMEOUT_MS = 120_000

/**
 * Vitest's per-test budget for this whole file.
 *
 * Set at file scope rather than per test: every test here spawns the compiled CLI, which costs seconds before any
 * assertion runs and then queues behind {@link withCLISpawnLockAsync}. A per-test annotation has to be remembered on
 * each new test, and the one that forgets inherits the global 15s — which kills the test before the thing being
 * measured can report, surfacing as a bare timeout with no attribution.
 */
vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS })

describe.skipIf(!hasCLICompiled)("mailwoman skill install", () => {
	const tempDirs: string[] = []

	async function makeTempDir(prefix: string): Promise<string> {
		const dir = fixtures.use(await temporaryDirectory(prefix)).path.toString()

		tempDirs.push(dir)

		return dir
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

		const skillPath = join(cwd, ".claude", "skills", "mailwoman", "SKILL.md")

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

		// The old sync form ran `spawn()` and then re-ran it inside `expect(spawn).not.toThrow()` — the second run IS
		// the idempotence assertion. An async rejection is invisible to that form, so await both runs: either one
		// failing rejects this test.
		await spawn()
		await spawn()

		const skillPath = join(cwd, ".claude", "skills", "mailwoman", "SKILL.md")

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

		expect(await pathExists(join(dest, ".claude", "skills", "mailwoman", "SKILL.md"))).toBe(true)
		expect(await pathExists(join(cwd, ".claude"))).toBe(false)
	})

	test("a stale file left over from an older shipped skill is removed, not merged", async () => {
		const cwd = await makeTempDir("mw-skill-install-stale-")
		const skillDir = join(cwd, ".claude", "skills", "mailwoman")
		const staleFile = join(skillDir, "stale-reference.md")

		// Plant a file that a hypothetical OLDER install left behind and the current shipped skill no
		// longer carries — a merge-only copy (bare cpSync) would leave this in place forever.
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
		expect(await pathExists(join(skillDir, "SKILL.md"))).toBe(true)
	})
})
