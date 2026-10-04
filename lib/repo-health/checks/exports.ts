/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Strict knip export verification with a narrow compatibility-alias allowlist.
 */

import { parseJSONStrict } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"

interface KnipSymbol {
	name: string
}

interface KnipIssue {
	binaries: KnipSymbol[]
	dependencies: KnipSymbol[]
	devDependencies: KnipSymbol[]
	duplicates: KnipSymbol[][]
	enumMembers: KnipSymbol[]
	exports: KnipSymbol[]
	file: string
	/**
	 * One entry when knip reports the file itself as unused, otherwise empty.
	 */
	files: KnipSymbol[]
	namespaceMembers: KnipSymbol[]
	optionalPeerDependencies: KnipSymbol[]
	types: KnipSymbol[]
	unlisted: KnipSymbol[]
	unresolved: KnipSymbol[]
}

interface KnipReport {
	issues: KnipIssue[]
}

/**
 * The per-file issue lists that produce one diagnostic per entry, with the message each entry gets.
 */
const SYMBOL_ISSUES: ReadonlyArray<[keyof KnipIssue, string]> = [
	["exports", "unused export"],
	["types", "unused exported type"],
	["enumMembers", "unused enum member"],
	["namespaceMembers", "unused namespace member"],
	["dependencies", "unused dependency"],
	["devDependencies", "unused devDependency"],
	["optionalPeerDependencies", "unused optional peer dependency"],
	["unlisted", "unlisted dependency"],
	["binaries", "unlisted binary"],
	["unresolved", "unresolved import"],
]

/**
 * Duplicate values intentionally exposed under both their current and compatibility names.
 */
const ALLOWED_DUPLICATE_EXPORTS = new Set([
	"packages/codex/lib/us/street/suffix.ts:StreetSuffixAbbreviationRecord,US_STREET_SUFFIX_VARIANTS",
	"packages/core/lib/decoder/containment.ts:PARENT_OF,WESTERN_PARENT_OF",
	"packages/corpus/lib/recipes/sub/venue.ts:buildPositiveForms,buildSubVenueForm",
	"packages/fastify/lib/index.ts:default,mailwomanFastify",
	"packages/mailwoman/tools/gazetteer-pipeline/defaults.ts:DEFAULT_FOLD_COUNTRIES,DEFAULT_GEONAMES_COUNTRIES",
])

function duplicateKey(file: string, symbols: KnipSymbol[]): string {
	return `${file}:${symbols
		.map(({ name }) => name)
		.toSorted()
		.join(",")}`
}

/**
 * The `exports` check: the repository's one knip run.
 *
 * It reports one error per unused file, unused or unlisted dependency,
 * unresolved import, unused export, type, enum member or namespace member,
 * and per duplicate export outside the reviewed compatibility aliases.
 * One run covers the three knip surfaces because each run parses the whole
 * workspace graph before reporting any of them.
 */
export const exportsCheck: RepoCheck = {
	id: "exports",
	description:
		"Every file, dependency and export is used (knip --files --dependencies --exports), apart from the reviewed compatibility aliases.",
	async run(context) {
		const { stdout } = await runFile(
			"yarn",
			["knip", "--files", "--dependencies", "--exports", "--reporter", "json", "--no-exit-code"],
			{
				cwd: context.repoRoot,
				maxBuffer: 16 * 1024 * 1024,
			}
		)

		const report = parseJSONStrict<KnipReport>(stdout)
		const diagnostics: Diagnostic[] = []
		const observedAllowedDuplicates = new Set<string>()

		const unexpected = (file: string, message: string): void => {
			diagnostics.push({ severity: DiagnosticSeverity.Error, message, file })
		}

		for (const issue of report.issues) {
			if (issue.files.length) {
				unexpected(issue.file, "unused file")
			}

			for (const [key, message] of SYMBOL_ISSUES) {
				for (const symbol of issue[key] as KnipSymbol[]) {
					unexpected(issue.file, `${message} ${symbol.name}`)
				}
			}

			for (const duplicate of issue.duplicates) {
				const key = duplicateKey(issue.file, duplicate)

				if (ALLOWED_DUPLICATE_EXPORTS.has(key)) {
					observedAllowedDuplicates.add(key)
				} else {
					unexpected(issue.file, `duplicate exports ${duplicate.map(({ name }) => name).join(", ")}`)
				}
			}
		}

		for (const expected of ALLOWED_DUPLICATE_EXPORTS) {
			if (!observedAllowedDuplicates.has(expected)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `stale duplicate-export allowlist entry ${expected}`,
				})
			}
		}

		return diagnostics
	},
}
