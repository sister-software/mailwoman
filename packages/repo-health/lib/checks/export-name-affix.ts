/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file An exported function whose name is another package's exported name plus an affix — `readWorkspaceDirectories`
 *   over `workspaceDirectories`, `listTrackedFiles` over `trackedFiles`. The longer name is how a duplicate arrives,
 *   because an author who knew the shorter name would have imported it.
 *
 *   The sibling {@linkcode findPrivateNameShadows} compares names for EQUALITY, which finds a copy only when both
 *   authors chose the same word. This compares camelCase component runs instead, which is what an affix leaves behind.
 *
 *   SCOPED ACROSS PACKAGES on purpose. Two names inside one package are usually a deliberate family
 *   (`buildPostcodeLocalityJP` beside `buildPostcodeLocality`); across packages, the shorter name has a public home the
 *   longer one could have imported.
 *
 *   A pair that stays says why, on the line above the longer declaration:
 *
 *       // repo-health-ignore export-name-affix -- <reason>
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { relative } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * The comment marker that keeps a deliberate pair out of the census, followed by the reason.
 */
export const AFFIX_IGNORE_MARKER = "repo-health-ignore export-name-affix --"

/**
 * How many camelCase components a shared run must carry. One-component runs are the vocabulary of the tree — `read`,
 * `build`, `file` — so a floor of one reports nearly every name against nearly every other; measured over this
 * repository's exported function names, the floor is the difference between 417 pairs and 130.
 */
const COMPONENT_FLOOR = 2

export interface AffixPair {
	/**
	 * Repo-relative path of the module declaring the longer name.
	 */
	file: string
	line: number
	name: string
	/**
	 * The shorter exported name spelled out inside it, and where that one lives.
	 */
	contains: string
	containedIn: string[]
}

interface ExportSite {
	file: string
	line: number
	name: string
	ignored: boolean
}

/**
 * Split an identifier into camelCase components, keeping a run of capitals whole and attaching digits to the capitals
 * they follow: `readPackageJSONFile` → `read`, `Package`, `JSON`, `File`.
 */
function nameComponents(name: string): string[] {
	return name.match(/[A-Z]+\d*(?![a-z])|[A-Z]?[a-z0-9]+|[A-Z]/gu) ?? []
}

/**
 * Every contiguous run of at least {@linkcode COMPONENT_FLOOR} components, shorter than the whole name, lowercased for
 * comparison.
 */
function containedRuns(name: string): string[] {
	const components = nameComponents(name)
	const runs = new Set<string>()

	for (let start = 0; start < components.length; start += 1) {
		for (let end = start + COMPONENT_FLOOR; end <= components.length; end += 1) {
			if (end - start === components.length) continue

			runs.add(components.slice(start, end).join("").toLowerCase())
		}
	}

	return [...runs]
}

function exportedFunctionSites(file: string, text: string): ExportSite[] {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
	const sites: ExportSite[] = []

	for (const statement of source.statements) {
		if (!ts.isFunctionDeclaration(statement) || !statement.name) continue

		if (!(ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue

		const leading = ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []

		// A formatter re-wraps a long comment, so the marker is matched with line breaks and leading asterisks collapsed.
		const ignored = leading.some((range) =>
			text
				.slice(range.pos, range.end)
				.replaceAll(/\s*\n\s*\*?\s*/gu, " ")
				.toLowerCase()
				.includes(AFFIX_IGNORE_MARKER)
		)

		sites.push({
			file,
			line: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1,
			name: statement.name.text,
			ignored,
		})
	}

	return sites
}

/**
 * The package a repo-relative path belongs to, so a family inside one workspace is not reported against itself.
 */
function packageOf(file: string): string {
	return file.split("/").slice(0, 2).join("/")
}

/**
 * Every exported function whose name spells out another package's exported name at greater length.
 */
export async function findAffixPairs(context: RepoContext): Promise<AffixPair[]> {
	const paths = await trackedSourcePaths(context, {
		// Both depths: git's fnmatch reads `**` as two stars, so `lib/**/*.ts` alone skips a file directly under `lib/`.
		globs: ["packages/*/lib/*.ts", "packages/*/lib/**/*.ts"],
		existingOnly: true,
	})

	const sites: ExportSite[] = []

	for (const path of paths) {
		const file = relative(context.repoRoot, path)

		if (file.includes("/test/") || file.endsWith(".d.ts")) continue

		sites.push(...exportedFunctionSites(file, await readLocalTextFile(path)))
	}

	const byLowerName = new Map<string, ExportSite[]>()

	for (const site of sites) {
		const key = site.name.toLowerCase()

		byLowerName.set(key, [...(byLowerName.get(key) ?? []), site])
	}

	// One diagnostic per declaration, not per matching run and not per overload: an overload set is one name, and a name
	// containing several shorter names is still one thing to look at.
	const pairs = new Map<string, AffixPair>()

	for (const site of sites) {
		if (site.ignored) continue

		for (const run of containedRuns(site.name)) {
			const elsewhere = (byLowerName.get(run) ?? []).filter((other) => packageOf(other.file) !== packageOf(site.file))

			if (!elsewhere.length) continue

			const key = `${site.file}:${site.name}`
			const existing = pairs.get(key)

			if (existing) {
				existing.containedIn = [...new Set([...existing.containedIn, ...elsewhere.map((other) => other.file)])]

				continue
			}

			pairs.set(key, {
				file: site.file,
				line: site.line,
				name: site.name,
				contains: elsewhere[0]!.name,
				containedIn: [...new Set(elsewhere.map((other) => other.file))],
			})
		}
	}

	return [...pairs.values()].toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

/**
 * The check: each pair as a warning, so a reviewer sees the longer name and the home the shorter one already has.
 */
export const exportNameAffixCheck: RepoCheck = {
	id: "export-name-affix",
	description:
		"An exported function in packages/*/lib whose name spells out another package's exported name at greater length — the shape a duplicate arrives in; import the shorter home, or keep the pair behind the ignore marker with a reason.",
	async run(context) {
		const diagnostics: Diagnostic[] = []

		for (const pair of await findAffixPairs(context)) {
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				file: pair.file,
				line: pair.line,
				message: `\`${pair.name}\` spells out \`${pair.contains}\`, exported from ${pair.containedIn.join(", ")}. Import that one, or keep both behind \`// ${AFFIX_IGNORE_MARKER} <reason>\`.`,
			})
		}

		return diagnostics
	},
}
