/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Strict knip export verification with a narrow compatibility-alias allowlist.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { runFile } from "@mailwoman/core/process"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

interface KnipSymbol {
	name: string
}

interface KnipIssue {
	duplicates: KnipSymbol[][]
	enumMembers: KnipSymbol[]
	exports: KnipSymbol[]
	file: string
	namespaceMembers: KnipSymbol[]
	types: KnipSymbol[]
}

interface KnipReport {
	issues: KnipIssue[]
}

/**
 * Duplicate values intentionally exposed under both their current and compatibility names.
 */
const ALLOWED_DUPLICATE_EXPORTS = new Set([
	"packages/codex/lib/us/street-suffix.ts:StreetSuffixAbbreviationRecord,US_STREET_SUFFIX_VARIANTS",
	"packages/core/lib/decoder/containment.ts:PARENT_OF,WESTERN_PARENT_OF",
	"packages/corpus/lib/recipes/sub-venue.ts:buildPositiveForms,buildSubVenueForm",
	"packages/fastify/lib/index.ts:default,mailwomanFastify",
	"packages/mailwoman/lib/gazetteer-pipeline/defaults.ts:DEFAULT_FOLD_COUNTRIES,DEFAULT_GEONAMES_COUNTRIES",
])

function duplicateKey(file: string, symbols: KnipSymbol[]): string {
	return `${file}:${symbols
		.map(({ name }) => name)
		.toSorted()
		.join(",")}`
}

/**
 * The `exports` check: one error per unused export, type, enum member or namespace member knip reports, and per
 * duplicate export outside the reviewed compatibility aliases.
 */
export const exportsCheck: RepoCheck = {
	id: "exports",
	description: "Every export is used (knip --exports), apart from the reviewed compatibility aliases.",
	async run(context) {
		const { stdout } = await runFile("yarn", ["knip", "--exports", "--reporter", "json", "--no-exit-code"], {
			cwd: context.repoRoot,
			maxBuffer: 16 * 1024 * 1024,
		})

		const report = parseJSONStrict<KnipReport>(stdout)
		const diagnostics: Diagnostic[] = []
		const observedAllowedDuplicates = new Set<string>()

		const unexpected = (file: string, message: string): void => {
			diagnostics.push({ severity: DiagnosticSeverity.Error, message, file })
		}

		for (const issue of report.issues) {
			for (const symbol of issue.exports) {
				unexpected(issue.file, `unused export ${symbol.name}`)
			}

			for (const symbol of issue.types) {
				unexpected(issue.file, `unused exported type ${symbol.name}`)
			}

			for (const symbol of issue.enumMembers) {
				unexpected(issue.file, `unused enum member ${symbol.name}`)
			}

			for (const symbol of issue.namespaceMembers) {
				unexpected(issue.file, `unused namespace member ${symbol.name}`)
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
