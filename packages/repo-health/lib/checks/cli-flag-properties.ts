/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every CLI flag fills a property some module names.
 *
 *   A command declares its flags in kebab case and reads them as properties; the router derives one from the other with
 *   `optionPropertyName`, whose table says which segments capitalize a whole acronym. A segment missing from that table
 *   title-cases instead, and the flag then reaches the component under a name nothing reads. Nothing reports it: the
 *   flag parses, passes validation, and does nothing, so the command succeeds and writes no file. Ten flags across
 *   seven commands were in that state when the table knew only `db` — `eval oa-resolver --out-json` among them.
 *
 *   The check derives each flag's property with the router's own function, so the check and the runtime cannot
 *   disagree, then asks whether any tracked source mentions that identifier. Mention, not declaration: a name that
 *   appears anywhere is at least read somewhere, and a name that appears nowhere cannot be. That admits a flag whose
 *   property collides with an unrelated identifier, and refuses every flag that is certainly inert.
 *
 *   Scope is the component command tree under `lib/commands/`, the one the router loads and whose flags it derives.
 *   `packages/mailwoman/lib/cli/native/commands/` is a different family: those read `parsed.values` by the kebab name
 *   itself (`stringValue(parsed.values, "signing-key")`), so no property is derived and none can disagree.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { optionPropertyName } from "@mailwoman/core/scripting/utils"
import { relative } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * The flag keys of one `spec.options` block: the object between `options: {` and the `satisfies CommandSpec` that
 * closes the spec. Only kebab keys are read — a single-segment flag derives itself and can never disagree.
 */
const KEBAB_FLAG = /["']([a-z0-9]+(?:-[a-z0-9]+)+)["']\s*:/gu

const SPEC_END = "} as const satisfies CommandSpec"

const IDENTIFIER = /\b[A-Za-z_$][\w$]*/gu

/**
 * The command tree the router loads and derives property names for.
 */
const DERIVED_COMMAND = /^packages\/[^/]+\/lib\/commands\//u

interface CommandFlags {
	file: string
	flags: string[]
}

function specFlags(source: string): string[] {
	const start = source.indexOf("options: {")

	if (start === -1) return []

	const end = source.indexOf(SPEC_END, start)
	const body = end === -1 ? source.slice(start) : source.slice(start, end)

	return [...body.matchAll(KEBAB_FLAG)].map(([, flag]) => flag!)
}

/**
 * The check that keeps the acronym table honest: a flag whose derived property no source mentions fails here rather
 * than parsing, validating and doing nothing.
 */
export const cliFlagPropertiesCheck: RepoCheck = {
	id: "cli-flag-properties",
	description:
		"Every kebab CLI flag derives a property name some tracked source mentions, so no flag parses and then fills a property nothing reads.",
	async run(context) {
		const sources = await trackedSourcePaths(context, {
			globs: ["packages/*/lib/*.ts", "packages/*/lib/*.tsx", "packages/*/lib/**/*.ts", "packages/*/lib/**/*.tsx"],
			existingOnly: true,
		})

		const mentioned = new Set<string>()
		const commands: CommandFlags[] = []

		for (const path of sources) {
			const source = await readLocalTextFile(path)

			for (const [identifier] of source.matchAll(IDENTIFIER)) {
				mentioned.add(identifier)
			}

			const file = relative(context.repoRoot, path)

			if (!DERIVED_COMMAND.test(file) || !source.includes(SPEC_END)) continue

			const flags = specFlags(source)

			if (flags.length) {
				commands.push({ file, flags })
			}
		}

		const diagnostics: Diagnostic[] = []

		for (const { file, flags } of commands) {
			for (const flag of flags) {
				const property = optionPropertyName(flag)

				if (mentioned.has(property)) continue

				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					file,
					message: `--${flag} derives options.${property}, which no tracked source mentions. Either the acronym table in @mailwoman/core/scripting/arguments is missing a segment, or the command reads a different name.`,
				})
			}
		}

		return diagnostics
	},
}
