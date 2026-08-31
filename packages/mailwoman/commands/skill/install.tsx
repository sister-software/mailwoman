/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman skill install [--dest <dir>]` — copies the packaged Claude Code skill
 *   (`skills/mailwoman/`, shipped inside this package) into `<dest>/.claude/skills/mailwoman/`.
 *   `--dest` defaults to the current working directory, so running this from a consumer project's
 *   root wires the skill into that project's `.claude/skills/` directory, exactly where Claude Code
 *   discovers project-level skills.
 *
 *   Idempotent via a clean-slate install: each run `rmSync`s the destination directory first, then
 *   `cpSync(..., { recursive: true, force: true })`s the packaged skill into it. The `rmSync` step is
 *   what makes "safe to re-run" true in GENERAL, not just today — `cpSync` alone is a MERGE copy: it
 *   overwrites a file that exists on both sides but never DELETES a destination file that a newer
 *   shipped skill version dropped. That gap is latent right now (the skill is one file, so there's
 *   nothing to leave behind) but would silently strand stale content the day the skill grows a second
 *   file and a later version renames or removes it upstream. Removing the whole destination first
 *   turns "merge" into "replace," which is what a reinstall should mean.
 *
 *   No destination-side symlink can precede the copy in this pipeline, so the `unlink`-then-`copyFile`
 *   discipline `scripts/copy-weights.ts` needs (AGENTS.md's "Pitfall: symlinks in the publish
 *   tarball") does not apply here: `rmSync` removes whatever sits at `destDir` — a symlink, a real
 *   directory, or nothing — as an unlink of that path itself, never by following it, so `cpSync`
 *   always writes into a directory it just created fresh. There is no step here that could write
 *   THROUGH a stale symlink the way a naive `fs.copyFile` onto an existing destination link would.
 *
 *   PACKAGE-RELATIVE RESOLUTION (source vs. compiled tree — see `core/utils/repo.ts`'s
 *   `__isCompiledTree` note): `skills/mailwoman/` ships as raw markdown via `package.json`'s `files`
 *   array, so tsc never emits a copy of it into `out/` — it sits at the SAME package-relative path
 *   (`<package root>/skills/mailwoman/`) whether this command runs from source or compiled. Only THIS
 *   file's own distance to that root changes between the two trees: source mode is
 *   `mailwoman/commands/skill/install.tsx` (package root two levels up); compiled is
 *   `mailwoman/out/commands/skill/install.js` (package root three levels up, past `out/`). Both
 *   candidates are tried and the one that exists on disk wins — the same bridge
 *   `eval-harness/baseline-assert.ts`'s `resolveBaselineFilePath` uses for its sibling JSON asset.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { copyPath, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { Text } from "ink"
import { resolvePath } from "path-ts"

import {
	type Check,
	CheckList,
	CommandError,
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "install",
	description: "Install the packaged Mailwoman skill.",
	options: {
		dest: { type: "string", description: "Destination project directory" },
	},
} as const satisfies CommandSpec

interface Options {
	dest?: string
}

/**
 * The packaged skill's source directory, resolved relative to THIS package's root. See the module docstring for why two
 * candidate distances are tried — exactly one exists on disk in any given tree.
 */
async function resolveSkillSourceDir(): Promise<string> {
	const dir = resolvePackagePath("mailwoman", "skills", "mailwoman")

	if (await pathExists(dir)) return dir

	throw new CommandError(
		`Could not locate the packaged skill directory at ${dir}. ` +
			"This is a packaging bug in the mailwoman npm package — please file an issue."
	)
}

interface InstallOutcome {
	ok: boolean
	checks: Check[]
}

async function installSkill(dest: string | undefined): Promise<InstallOutcome> {
	const checks: Check[] = []

	try {
		const sourceDir = await resolveSkillSourceDir()
		const destDir = resolvePath(dest ?? ".", ".claude", "skills", "mailwoman")

		// Clean-slate, not merge — see the module docstring for why a bare cpSync isn't enough.
		await removePathIfPresent(destDir)
		await copyPath(sourceDir, destDir)

		checks.push({ ok: true, check: "mailwoman skill", detail: `installed at ${destDir}` })

		return { ok: true, checks }
	} catch (error) {
		checks.push({
			ok: false,
			check: "mailwoman skill",
			detail: error instanceof Error ? error.message : String(error),
		})

		return { ok: false, checks }
	}
}

const SkillInstall: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => await installSkill(options.dest),
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status !== "done")
		return <CommandTaskResult state={state} running={<Text color="gray">installing…</Text>} />

	if (state.status === "done") {
		return <CheckList checks={state.result.checks} verdict={state.result.ok} />
	}

	return null
}

export default SkillInstall
