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

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { repoRootPath } from "@mailwoman/core/utils"
import { afterEach, describe, expect, test } from "vitest"

import { withCLISpawnLock } from "../test-kit/cli-spawn-lock.ts"

const CLI_PATH = repoRootPath("mailwoman", "out", "cli.js")
const hasCLICompiled = existsSync(CLI_PATH)

/**
 * Wall-clock budget for a CLI spawn — see the note in `geocode.test.ts`. A single spawn costs ~5.6 s, 2.7 s of it node
 * boot alone.
 */
const CLI_SPAWN_TIMEOUT_MS = 45_000

describe.skipIf(!hasCLICompiled)("mailwoman skill install", () => {
	const tempDirs: string[] = []

	function makeTempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix))

		tempDirs.push(dir)

		return dir
	}

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test("installs into <cwd>/.claude/skills/mailwoman/SKILL.md by default", () => {
		const cwd = makeTempDir("mw-skill-install-")

		withCLISpawnLock(() =>
			execFileSync(process.execPath, [CLI_PATH, "skill", "install"], {
				cwd,
				encoding: "utf8",
				timeout: CLI_SPAWN_TIMEOUT_MS,
			})
		)

		const skillPath = join(cwd, ".claude", "skills", "mailwoman", "SKILL.md")

		expect(existsSync(skillPath)).toBe(true)
		expect(readFileSync(skillPath, "utf8")).toMatch(/^---\nname: mailwoman\n/)
	})

	test("second run is idempotent — overwrites cleanly with no error", () => {
		const cwd = makeTempDir("mw-skill-install-idempotent-")

		const spawn = () =>
			withCLISpawnLock(() =>
				execFileSync(process.execPath, [CLI_PATH, "skill", "install"], {
					cwd,
					encoding: "utf8",
					timeout: CLI_SPAWN_TIMEOUT_MS,
				})
			)

		spawn()
		expect(spawn).not.toThrow()

		const skillPath = join(cwd, ".claude", "skills", "mailwoman", "SKILL.md")

		expect(existsSync(skillPath)).toBe(true)
	})

	test("--dest <dir> installs there instead of cwd", () => {
		const cwd = makeTempDir("mw-skill-install-cwd-")
		const dest = makeTempDir("mw-skill-install-dest-")

		withCLISpawnLock(() =>
			execFileSync(process.execPath, [CLI_PATH, "skill", "install", "--dest", dest], {
				cwd,
				encoding: "utf8",
				timeout: CLI_SPAWN_TIMEOUT_MS,
			})
		)

		expect(existsSync(join(dest, ".claude", "skills", "mailwoman", "SKILL.md"))).toBe(true)
		expect(existsSync(join(cwd, ".claude"))).toBe(false)
	})

	test("a stale file left over from an older shipped skill is removed, not merged", () => {
		const cwd = makeTempDir("mw-skill-install-stale-")
		const skillDir = join(cwd, ".claude", "skills", "mailwoman")
		const staleFile = join(skillDir, "stale-reference.md")

		// Plant a file that a hypothetical OLDER install left behind and the current shipped skill no
		// longer carries — a merge-only copy (bare cpSync) would leave this in place forever.
		mkdirSync(skillDir, { recursive: true })
		writeFileSync(staleFile, "belongs to an older skill version; must not survive a reinstall")

		withCLISpawnLock(() =>
			execFileSync(process.execPath, [CLI_PATH, "skill", "install"], {
				cwd,
				encoding: "utf8",
				timeout: CLI_SPAWN_TIMEOUT_MS,
			})
		)

		expect(existsSync(staleFile)).toBe(false)
		expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true)
	})
})
