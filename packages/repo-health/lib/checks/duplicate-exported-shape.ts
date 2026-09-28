/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Finds an exported `interface` or `type` alias whose body matches one from another workspace. Two
 *   packages that declare the same shape have two homes for one declaration. They can drift when either is edited.
 *   A declaration several packages need has one home and is imported with `import type`, which
 *   adds zero modules to the importing package's runtime graph.
 *
 *   The check reads exported interfaces, type literal aliases and union aliases under `packages/*\/lib`.
 *   It keys each one by its body after dropping comments, collapsing whitespace and sorting members.
 *   Two declarations with
 *   the same key in different workspaces form a group. Names are ignored: `GeoCoordinate` and `LatLng` with the
 *   same two fields are one shape. A declaration with the same key inside one workspace is the
 *   `mailwoman/prefer-home` lint rule's concern and is left out here.
 *
 *   A single-member interface, a one-member union or an alias of a bare reference such as `type Id = string`
 *   are skipped: they agree by coincidence far more often than by copy. Member order is normalized one level
 *   deep. A nested type literal keeps its written order.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { relative } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * One exported shape declaration and the key its body reduces to.
 */
export interface ShapeSite {
	file: string
	line: number
	name: string
	/**
	 * The workspace directory name under `packages/`.
	 */
	workspace: string
	/**
	 * The normalized body.
	 * Two sites with one key declare one shape.
	 */
	key: string
}

/**
 * A group of exported declarations across at least two workspaces with one key.
 */
export interface DuplicateShape {
	key: string
	sites: ShapeSite[]
}

/**
 * The fewest members a body needs before agreement reads as a copy rather than a coincidence.
 */
const MEMBER_FLOOR = 2

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })

/**
 * The text of a node with comments dropped and whitespace collapsed to single spaces.
 */
function normalized(node: ts.Node, source: ts.SourceFile): string {
	return printer.printNode(ts.EmitHint.Unspecified, node, source).replaceAll(/\s+/gu, " ").trim()
}

/**
 * The sorted, normalized members of a type literal or interface body, or undefined below the floor.
 */
function memberKey(members: ts.NodeArray<ts.TypeElement>, source: ts.SourceFile): string | undefined {
	if (members.length < MEMBER_FLOOR) return undefined

	const parts = members.map((member) => normalized(member, source).replace(/;$/u, ""))

	return `{ ${parts.toSorted().join("; ")} }`
}

/**
 * The type parameters and heritage clauses on a declaration, so `Foo<T>` and `Foo` stay apart.
 */
function headerKey(node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration, source: ts.SourceFile): string {
	const parameters = node.typeParameters?.map((parameter) => normalized(parameter, source)).join(", ") ?? ""

	const heritage = ts.isInterfaceDeclaration(node)
		? (node.heritageClauses?.map((clause) => normalized(clause, source)).join(" ") ?? "")
		: ""

	return `${parameters ? `<${parameters}>` : ""}${heritage ? ` ${heritage}` : ""}`
}

/**
 * The key of an exported interface or alias, or undefined for a body this does not compare.
 *
 * An interface and a type-literal alias with the same members share a key,
 * since the two spellings declare one shape.
 */
function shapeKey(node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration, source: ts.SourceFile): string | undefined {
	const header = headerKey(node, source)

	if (ts.isInterfaceDeclaration(node)) {
		const body = memberKey(node.members, source)

		return body ? `shape${header} ${body}` : undefined
	}

	if (ts.isTypeLiteralNode(node.type)) {
		const body = memberKey(node.type.members, source)

		return body ? `shape${header} ${body}` : undefined
	}

	if (ts.isUnionTypeNode(node.type)) {
		if (node.type.types.length < MEMBER_FLOOR) return undefined

		const parts = node.type.types.map((member) => normalized(member, source))

		return `union${header} ${parts.toSorted().join(" | ")}`
	}

	return undefined
}

function hasExportModifier(node: ts.HasModifiers): boolean {
	return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
}

/**
 * Every exported shape declaration in one file with the key its body reduces to.
 */
export function shapeSites(file: string, text: string): ShapeSite[] {
	const source = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		false,
		file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	)

	const workspace = file.split("/")[1] ?? ""
	const sites: ShapeSite[] = []

	for (const statement of source.statements) {
		if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) continue

		if (!hasExportModifier(statement)) continue

		const key = shapeKey(statement, source)

		if (!key) continue

		const { line } = source.getLineAndCharacterOfPosition(statement.name.getStart(source))

		sites.push({ file, line: line + 1, name: statement.name.text, workspace, key })
	}

	return sites
}

/**
 * Every shape two or more workspaces export under `packages/*\/lib`, with each site that declares it.
 */
export async function findDuplicateShapes(context: RepoContext): Promise<DuplicateShape[]> {
	const paths = await trackedSourcePaths(context, {
		// Both depths: git's fnmatch reads `**` as two stars, so `lib/**/*.ts` by itself skips a file
		// directly under `lib/` (`lib/index.ts`), the same quirk `tracked-sources.ts` documents.
		globs: ["packages/*/lib/*.ts", "packages/*/lib/*.tsx", "packages/*/lib/**/*.ts", "packages/*/lib/**/*.tsx"],
		existingOnly: true,
	})

	const byKey = new Map<string, ShapeSite[]>()

	for (const path of paths) {
		const file = relative(context.repoRoot, path)

		if (file.includes("/test/") || file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue

		for (const site of shapeSites(file, await readLocalTextFile(path))) {
			byKey.set(site.key, [...(byKey.get(site.key) ?? []), site])
		}
	}

	const duplicates: DuplicateShape[] = []

	for (const [key, sites] of byKey) {
		const workspaces = new Set(sites.map((site) => site.workspace))

		if (workspaces.size < 2) continue

		duplicates.push({
			key,
			sites: sites.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
		})
	}

	return duplicates.toSorted(
		(a, b) => a.sites[0]!.file.localeCompare(b.sites[0]!.file) || a.sites[0]!.line - b.sites[0]!.line
	)
}

/**
 * The check: one warning per duplicated shape, listing every site so the reader can choose the home.
 */
export const duplicateExportedShapeCheck: RepoCheck = {
	id: "duplicate-exported-shape",
	description:
		"An exported interface or type alias in packages/*/lib whose body is identical to one another workspace exports. Give the declaration one home and import it with `import type`.",
	async run(context) {
		const diagnostics: Diagnostic[] = []

		for (const duplicate of await findDuplicateShapes(context)) {
			const [first, ...rest] = duplicate.sites
			const names = [...new Set(duplicate.sites.map((site) => site.name))].join(", ")

			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				file: first!.file,
				line: first!.line,
				message: `\`${names}\` is one shape exported from ${duplicate.sites.length} sites across ${new Set(duplicate.sites.map((site) => site.workspace)).size} workspaces. Keep one and import it with \`import type\`.`,
				details: rest.map((site) => `${site.file}:${site.line} ${site.name}`),
			})
		}

		return diagnostics
	},
}
