/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Strict Knip export verification with a narrow compatibility-alias allowlist.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { repoRootPath } from "@mailwoman/core/paths"
import { runFileSync } from "@mailwoman/core/process"

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

const output = runFileSync("yarn", ["knip", "--exports", "--reporter", "json", "--no-exit-code"], {
	cwd: String(repoRootPath()),
	encoding: "utf8",
	maxBuffer: 16 * 1024 * 1024,
})

const report = parseJSONStrict<KnipReport>(output)
const unexpected: string[] = []
const observedAllowedDuplicates = new Set<string>()

for (const issue of report.issues) {
	for (const symbol of issue.exports) {
		unexpected.push(`${issue.file}: unused export ${symbol.name}`)
	}

	for (const symbol of issue.types) {
		unexpected.push(`${issue.file}: unused exported type ${symbol.name}`)
	}

	for (const symbol of issue.enumMembers) {
		unexpected.push(`${issue.file}: unused enum member ${symbol.name}`)
	}

	for (const symbol of issue.namespaceMembers) {
		unexpected.push(`${issue.file}: unused namespace member ${symbol.name}`)
	}

	for (const duplicate of issue.duplicates) {
		const key = duplicateKey(issue.file, duplicate)

		if (ALLOWED_DUPLICATE_EXPORTS.has(key)) {
			observedAllowedDuplicates.add(key)
		} else {
			unexpected.push(`${issue.file}: duplicate exports ${duplicate.map(({ name }) => name).join(", ")}`)
		}
	}
}

for (const expected of ALLOWED_DUPLICATE_EXPORTS) {
	if (!observedAllowedDuplicates.has(expected)) {
		unexpected.push(`stale duplicate-export allowlist entry ${expected}`)
	}
}

if (unexpected.length) {
	throw new Error(`Export hygiene failed:\n${unexpected.map((issue) => `- ${issue}`).join("\n")}`)
}

process.stdout.write(
	`Export hygiene passed; ${observedAllowedDuplicates.size} reviewed compatibility aliases remain.\n`
)
