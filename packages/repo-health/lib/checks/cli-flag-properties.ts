/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every CLI flag fills a property some module names.
 *
 *   A flag whose segment is missing from `optionPropertyName`'s table title-cases instead and reaches the component
 *   under a name no code reads, so it parses, validates, and has no effect.
 *
 *   The check derives each flag's property with that same function and asks whether any tracked source mentions it,
 *   over the component command tree under `lib/commands/`; the `native/commands/` family reads `parsed.values` by
 *   the kebab name itself and derives no property.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { optionPropertyName } from "@mailwoman/core/scripting/utils"
import { relative } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * The kebab-case flag keys of one `spec.options` block, from `options: {` to the `satisfies CommandSpec`
 * that closes the spec; a single-segment flag derives itself and can never disagree.
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
 * A flag whose derived property no tracked source mentions fails here rather than parsing, validating, and having
 * no effect.
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
