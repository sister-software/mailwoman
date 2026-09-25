/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus migrate-recipe-outputs` — rewrite recipe output jsonl files onto the current row schema, in place.
 *
 *   Each file is migrated to a sibling `<name>.migrated` and then moved over the original, so a refused file leaves its
 *   original intact. A row that already carries `surface` passes through unchanged, so a second run over a migrated
 *   file rewrites no row.
 */

import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { CommandError } from "@mailwoman/core/scripting/command"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "migrate-recipe-outputs",
	description: "Migrate recipe output jsonl files onto the current row schema, in place.",
	options: {
		files: { type: "string", required: true, description: "Recipe output jsonl paths, comma-separated" },
	},
} as const satisfies CommandSpec

const Cmd: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { movePath, removePathIfPresent } = await import("@mailwoman/core/fs/writers")
		const { migrateRecipeOutput } = await import("@mailwoman/corpus/tools/migrate-recipe-output")

		const files = extractDelimited(options.files)
		const refused: string[] = []

		for (const input of files) {
			const staged = `${input}.migrated`

			try {
				const summary = await migrateRecipeOutput(input, staged)

				await movePath(staged, input)

				console.log(
					`${input}: ${summary.rows} rows, ${summary.alreadyMigrated} already current, ` +
						`sources ${Object.keys(summary.bySource).join(", ")}`
				)
			} catch (error) {
				await removePathIfPresent(staged)
				refused.push(`${input}: ${(error as Error).message}`)
			}
		}

		if (refused.length) {
			throw new CommandError(`${refused.length} of ${files.length} files were not migrated:\n${refused.join("\n")}`)
		}

		return `migrated ${files.length} files`
	})

	return <CommandTaskResult state={state} />
}

export default Cmd
