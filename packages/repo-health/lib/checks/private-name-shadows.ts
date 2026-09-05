/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A module-private function that shares its name with a function another module exports is either a re-typed
 *   copy or a collision, and both are worth one look before merge. `mailwoman/prefer-home` reports the shapes someone
 *   has already tabled; this is the detector for the shape nobody has tabled yet. A 2026-09-04 census found 39 such
 *   pairs across `packages/*\/lib`: two were true copies (`percentile` with the percentile as a fraction, a second
 *   `pyRound`), the rest thin wrappers, deliberate dependency-free copies, or same-name-different-thing.
 *
 *   A copy that stays says why, on the line above it:
 *
 *       // repo-health-ignore private-name-shadows-export -- <reason>
 *
 *   The `debt` check pins the count so the number ratchets down; this check names each site.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { relative } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * The comment marker that keeps a deliberate copy out of the census. It must be followed by the reason, on the line
 * above the function.
 */
export const SHADOW_IGNORE_MARKER = "repo-health-ignore private-name-shadows-export --"

/**
 * Names too generic to mean the same thing twice: a private `normalize` beside an exported `normalize` is two different
 * normalizations, not a copy.
 */
const GENERIC_NAMES: ReadonlySet<string> = new Set([
	"normalize",
	"decide",
	"runOne",
	"renderRow",
	"dispatchCommand",
	"main",
	"run",
	"parse",
	"format",
	"render",
	"build",
	"create",
	"handle",
	"process",
])

const MINIMUM_NAME_LENGTH = 5

export interface PrivateNameShadow {
	/**
	 * Repo-relative path of the module holding the private function.
	 */
	file: string
	line: number
	name: string
	/**
	 * Repo-relative paths of the modules exporting a function of the same name.
	 */
	exportedIn: string[]
}

interface FunctionSite {
	file: string
	line: number
	name: string
	exported: boolean
	ignored: boolean
}

function hasExportModifier(node: ts.FunctionDeclaration): boolean {
	return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
}

function functionSites(file: string, text: string): FunctionSite[] {
	const source = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		false,
		file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	)

	const sites: FunctionSite[] = []

	for (const statement of source.statements) {
		if (!ts.isFunctionDeclaration(statement) || !statement.name) continue

		const name = statement.name.text
		const start = statement.getStart(source)
		const line = source.getLineAndCharacterOfPosition(start).line
		const leading = ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []

		// A formatter re-wraps a long JSDoc line and capitalizes a paragraph's first word, so the marker is matched with
		// the comment's line breaks and leading asterisks collapsed to single spaces and the case folded.
		const ignored = leading.some((range) =>
			text
				.slice(range.pos, range.end)
				.replaceAll(/\s*\n\s*\*?\s*/gu, " ")
				.toLowerCase()
				.includes(SHADOW_IGNORE_MARKER)
		)

		sites.push({ file, line: line + 1, name, exported: hasExportModifier(statement), ignored })
	}

	return sites
}

/**
 * Every module-private top-level function in `packages/*\/lib` whose name another module exports, minus the generic
 * names, the short ones, and the copies that carry the ignore marker with a reason.
 */
export async function findPrivateNameShadows(context: RepoContext): Promise<PrivateNameShadow[]> {
	const paths = await trackedSourcePaths(context, {
		// Both depths: git's fnmatch reads `**` as two stars, so `lib/**/*.ts` alone skips a file directly under `lib/`
		// (`lib/index.ts`), the same quirk `tracked-sources.ts` documents.
		globs: ["packages/*/lib/*.ts", "packages/*/lib/*.tsx", "packages/*/lib/**/*.ts", "packages/*/lib/**/*.tsx"],
		existingOnly: true,
	})

	const exportedBy = new Map<string, string[]>()
	const privates: FunctionSite[] = []

	for (const path of paths) {
		const file = relative(context.repoRoot, path)

		if (file.includes("/test/") || file.endsWith(".d.ts")) continue

		for (const site of functionSites(file, await readLocalTextFile(path))) {
			if (site.exported) {
				exportedBy.set(site.name, [...(exportedBy.get(site.name) ?? []), site.file])
			} else {
				privates.push(site)
			}
		}
	}

	const shadows: PrivateNameShadow[] = []

	for (const site of privates) {
		if (site.ignored || site.name.length < MINIMUM_NAME_LENGTH || GENERIC_NAMES.has(site.name)) continue

		const exportedIn = (exportedBy.get(site.name) ?? []).filter((file) => file !== site.file)

		if (exportedIn.length) {
			shadows.push({ file: site.file, line: site.line, name: site.name, exportedIn })
		}
	}

	return shadows.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

/**
 * The check the 2026-09-04 name-shadow census asked for: each site as a warning, so a reviewer sees the copy and the
 * home it may already have.
 */
export const privateNameShadowsCheck: RepoCheck = {
	id: "private-name-shadows-export",
	description:
		"A module-private function in packages/*/lib sharing its name with a function another module exports — a copy or a collision; import the home or keep the copy behind the ignore marker with a reason.",
	async run(context) {
		const diagnostics: Diagnostic[] = []

		for (const shadow of await findPrivateNameShadows(context)) {
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				file: shadow.file,
				line: shadow.line,
				message: `private \`${shadow.name}\` shares its name with the export in ${shadow.exportedIn.join(", ")}. Import the home, or keep the copy behind \`// ${SHADOW_IGNORE_MARKER} <reason>\`.`,
			})
		}

		return diagnostics
	},
}
