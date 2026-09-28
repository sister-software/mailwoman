/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus migrate-source-names` — rewrite each named parquet's `source` column from the retired
 *   `synth-*` spelling to the operation spelling `RECIPE_SOURCES` gives it.
 *
 *   Run this over an assembly's routed staging files before `corpus overlay-manifest`, so the manifest's
 *   `sha256` describes the renamed bytes. A corpus already assembled is never rewritten in place.
 *
 *   Each rewrite is written beside its input as `<name>.renamed` and swapped over the input only with
 *   `--swap`, so a run that refuses one file leaves every other file readable by the code that built it.
 *   The run writes `source-names.json` beside the first input, recording every mapping it applied.
 */

import { CommandError } from "@mailwoman/core/scripting/command"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "migrate-source-names",
	description: "Rewrite parquet `source` values from the retired synth- spelling to the operation spelling.",
	options: {
		parquet: { type: "string", required: true, description: "Parquet files to rewrite, comma-separated" },
		swap: {
			type: "boolean",
			default: false,
			description: "Move each rewrite over its input once every file has been rewritten and verified",
		},
		out: { type: "string", description: "Where to write the record of the mappings applied" },
	},
} as const satisfies CommandSpec

const Cmd: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { extractDelimited } = await import("@mailwoman/core/scripting/arguments")
		const { movePath, writeLocalJSONFile } = await import("@mailwoman/core/fs/writers")
		const { dirname, resolvePath } = await import("path-ts")
		const { rewriteSourceNames } = await import("@mailwoman/corpus/tools/migrate-source-names")

		const inputs = extractDelimited(options.parquet)

		if (!inputs.length) throw new CommandError("--parquet names no file")

		const applied: Array<Awaited<ReturnType<typeof rewriteSourceNames>>> = []
		const refused: string[] = []

		for (const input of inputs) {
			try {
				const summary = await rewriteSourceNames(input)

				applied.push(summary)

				const mapped = Object.entries(summary.renamed)
					.map(([retired, current]) => `${retired} → ${current}`)
					.join(", ")

				console.log(`  ${summary.rows.toLocaleString("en-US")} rows  ${mapped || "already current"}  ${input}`)
			} catch (error) {
				refused.push(`${input}: ${(error as Error).message}`)
			}
		}

		// Every file is rewritten and verified before any input is replaced, so a refusal
		// partway through leaves the staging directory in one spelling rather than two.
		if (refused.length) {
			throw new CommandError(
				`${refused.length} of ${inputs.length} files were not rewritten, and no input was replaced:\n` +
					refused.join("\n")
			)
		}

		const out = options.out ?? resolvePath(dirname(inputs[0]!), "source-names.json")

		await writeLocalJSONFile({ appliedAt: new Date().toISOString(), files: applied }, out)

		if (options.swap) {
			for (const summary of applied) {
				if (!Object.keys(summary.renamed).length) continue

				await movePath(`${summary.parquet}.renamed`, summary.parquet)
			}
		}

		return (
			`rewrote ${applied.length} file(s), ${applied.filter((entry) => Object.keys(entry.renamed).length).length} ` +
			`carrying a retired spelling; wrote ${out}` +
			(options.swap ? "; each rewrite was moved over its input" : "; pass --swap to replace the inputs")
		)
	})

	return <CommandTaskResult state={state} />
}

export default Cmd
