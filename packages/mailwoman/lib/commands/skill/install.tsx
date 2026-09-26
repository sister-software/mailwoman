/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { copyPath, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { CommandError } from "@mailwoman/core/scripting/command"
import { Text } from "ink"
import { resolvePath } from "path-ts"

import {
	type Check,
	CheckList,
	type CommandSpec,
	CommandTaskResult,
	type CommandComponent,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "install",
	description: "Install the packaged Mailwoman skill.",
	options: {
		dest: { type: "string", description: "Destination project directory" },
	},
} as const satisfies CommandSpec

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

		// Remove the whole destination first: copyPath merges and would strand files a newer skill drops.
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

const SkillInstall: CommandComponent<typeof spec> = ({ options }) => {
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
