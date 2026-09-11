/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reports modules whose top-level declarations fall into communities that share no imported dependency.
 *
 *   The companion to {@link ./surface.ts}, which counts declarations. A count answers "is this module
 *   large"; this one answers "is this module two modules", which is a property of the reference graph and not of any
 *   total. A module that reads one table and returns a value stays one community however long it grows; a module whose
 *   pure transform and whose filesystem walker never call each other is two, at any size.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { relative } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * What a module must exceed before its partition is reported.
 */
export const MODULE_COHESION_THRESHOLDS = {
	/**
	 * Under this many lines a module is readable whole, and which declarations group with which changes nothing a reader
	 * would do about it.
	 */
	lines: 400,
	/**
	 * Newman's modularity of the best partition found. A module whose helpers all feed one entry point scores near zero
	 * however many helpers there are.
	 */
	modularity: 0.35,
	/**
	 * Members a community needs before it counts toward a reported pair. A lone declaration is a helper, not a
	 * responsibility.
	 */
	communityMembers: 2,
	/**
	 * Distinct imported specifiers a community needs before it counts toward a reported pair. One shared import is what a
	 * facade of same-shaped wrappers looks like — `@mailwoman/core/fs/readers` partitions into eleven such groups and is
	 * correct as written.
	 */
	communitySpecifiers: 2,
} as const

const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx)$/u
const MAX_PASSES = 20
const GAIN_EPSILON = 1e-9

/**
 * One top-level declaration that holds a value. Type-only declarations are left out of the graph deliberately: a type
 * referenced by every group joins all of them, and one partition of nineteen declarations is the result.
 */
interface ValueDeclaration {
	name: string
	node: ts.Node
	exported: boolean
	line: number
}

/**
 * A group of declarations that reference each other more than they reference the rest of the module.
 */
export interface DeclarationCommunity {
	names: readonly string[]
	exported: boolean
	/**
	 * The module specifiers this community's members read, which is what makes two communities comparable: the graph says
	 * they are separate, and the imports say whether they are separate about different things.
	 */
	specifiers: ReadonlySet<string>
	line: number
}

/**
 * The partition of one module, and the community pairs that look separable.
 */
export interface ModuleCohesion {
	modularity: number
	communities: readonly DeclarationCommunity[]
	/**
	 * Community pairs that are each substantial on their own and share no imported dependency.
	 */
	disjointPairs: ReadonlyArray<readonly [DeclarationCommunity, DeclarationCommunity]>
}

function topLevelValues(source: ts.SourceFile): ValueDeclaration[] {
	const declarations: ValueDeclaration[] = []

	const record = (name: string, node: ts.Declaration, statement: ts.Statement): void => {
		declarations.push({
			name,
			node,
			// Read off the declaration rather than the statement: `getCombinedModifierFlags` walks a variable
			// declaration up through its list to the `export` that covers it, and a statement carries no such link.
			exported: !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export),
			line: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1,
		})
	}

	for (const statement of source.statements) {
		if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
			record(statement.name.text, statement, statement)
		} else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) {
					record(declaration.name.text, declaration, statement)
				}
			}
		}
	}

	return declarations
}

/**
 * Every value binding an import introduces, mapped to the specifier it came from. Type-only imports are skipped: they
 * are erased before anything runs, so they say nothing about what a declaration does.
 */
function importedBindings(source: ts.SourceFile): Map<string, string> {
	const bindings = new Map<string, string>()

	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement) || !statement.importClause) continue

		if (statement.importClause.phaseModifier === ts.SyntaxKind.TypeKeyword) continue

		if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue

		const specifier = statement.moduleSpecifier.text
		const clause = statement.importClause

		if (clause.name) {
			bindings.set(clause.name.text, specifier)
		}

		const named = clause.namedBindings

		if (named && ts.isNamespaceImport(named)) {
			bindings.set(named.name.text, specifier)
		}

		if (named && ts.isNamedImports(named)) {
			for (const element of named.elements) {
				if (!element.isTypeOnly) {
					bindings.set(element.name.text, specifier)
				}
			}
		}
	}

	return bindings
}

/**
 * One level of Louvain over an unweighted undirected graph: move each node to the neighbouring community with the
 * largest modularity gain, and repeat until a whole pass moves nothing.
 */
function partitionByModularity(adjacency: ReadonlyArray<ReadonlySet<number>>): {
	modularity: number
	groups: number[][]
} {
	const degree = adjacency.map((neighbours) => neighbours.size)
	const edges = degree.reduce((sum, count) => sum + count, 0) / 2
	const community = adjacency.map((_, node) => node)

	if (edges === 0) return { modularity: 0, groups: community.map((node) => [node]) }

	const attached = [...degree]
	let moved = true
	let pass = 0

	while (moved && pass++ < MAX_PASSES) {
		moved = false

		for (let node = 0; node < adjacency.length; node++) {
			const origin = community[node]!
			attached[origin]! -= degree[node]!

			const shared = new Map<number, number>([[origin, 0]])

			for (const neighbour of adjacency[node]!) {
				const target = community[neighbour]!
				shared.set(target, (shared.get(target) ?? 0) + 1)
			}

			let best = origin
			let bestGain = -Infinity

			for (const [target, links] of shared) {
				const gain = links - (attached[target]! * degree[node]!) / (2 * edges)

				if (gain > bestGain + GAIN_EPSILON) {
					bestGain = gain
					best = target
				}
			}

			attached[best]! += degree[node]!

			if (best !== origin) {
				community[node] = best
				moved = true
			}
		}
	}

	const groups = new Map<number, number[]>()
	const internal = new Map<number, number>()
	const total = new Map<number, number>()

	community.forEach((group, node) => {
		groups.set(group, [...(groups.get(group) ?? []), node])
		total.set(group, (total.get(group) ?? 0) + degree[node]!)

		let inside = 0

		for (const neighbour of adjacency[node]!) {
			if (community[neighbour] === group) {
				inside++
			}
		}

		internal.set(group, (internal.get(group) ?? 0) + inside)
	})

	let modularity = 0

	for (const [group, inside] of internal) {
		modularity += inside / (2 * edges) - ((total.get(group) ?? 0) / (2 * edges)) ** 2
	}

	return { modularity, groups: [...groups.values()].toSorted((a, b) => b.length - a.length) }
}

/**
 * Partition `source` by which top-level declarations reference each other, then read each community's imports.
 */
export function moduleCohesion(source: ts.SourceFile): ModuleCohesion {
	const declarations = topLevelValues(source)
	const bindings = importedBindings(source)
	const position = new Map(declarations.map((declaration, at) => [declaration.name, at]))
	const adjacency = declarations.map(() => new Set<number>())
	const specifiers = declarations.map(() => new Set<string>())

	declarations.forEach((declaration, at) => {
		const visit = (node: ts.Node): void => {
			if (ts.isIdentifier(node)) {
				const referenced = position.get(node.text)

				if (referenced !== undefined && referenced !== at) {
					adjacency[at]!.add(referenced)
					adjacency[referenced]!.add(at)
				}

				const specifier = bindings.get(node.text)

				if (specifier) {
					specifiers[at]!.add(specifier)
				}
			}

			ts.forEachChild(node, visit)
		}

		ts.forEachChild(declaration.node, visit)
	})

	const { modularity, groups } = partitionByModularity(adjacency)

	const communities: DeclarationCommunity[] = groups.map((members) => ({
		names: members.map((at) => declarations[at]!.name),
		exported: members.some((at) => declarations[at]!.exported),
		specifiers: new Set(members.flatMap((at) => [...specifiers[at]!])),
		line: Math.min(...members.map((at) => declarations[at]!.line)),
	}))

	const substantial = communities.filter(
		(community) =>
			community.exported &&
			community.names.length >= MODULE_COHESION_THRESHOLDS.communityMembers &&
			community.specifiers.size >= MODULE_COHESION_THRESHOLDS.communitySpecifiers
	)

	const disjointPairs: Array<readonly [DeclarationCommunity, DeclarationCommunity]> = []

	for (let first = 0; first < substantial.length; first++) {
		for (let second = first + 1; second < substantial.length; second++) {
			const left = substantial[first]!
			const right = substantial[second]!

			if ([...left.specifiers].some((specifier) => right.specifiers.has(specifier))) continue

			disjointPairs.push([left, right])
		}
	}

	return { modularity, communities, disjointPairs }
}

function describe(community: DeclarationCommunity): string {
	const [head, ...rest] = community.names
	const label = rest.length ? `${head} (+${rest.length})` : head
	const specifiers = [...community.specifiers].slice(0, 3).join(", ")

	return `${label} reads ${specifiers}`
}

/**
 * Advisory partition of a module's declaration graph. A warning names the two groups and the dependencies that separate
 * them; it proposes which declarations move together and does not claim the module is wrong.
 */
export const moduleCohesionCheck: RepoCheck = {
	id: "module-cohesion",
	description:
		"Warn when a large module's top-level declarations partition into communities that share no imported dependency.",
	async run(context: RepoContext): Promise<Diagnostic[]> {
		const diagnostics: Diagnostic[] = []

		for (const filePath of await trackedSourcePaths(context, { prefix: "packages/", existingOnly: true })) {
			const file = relative(context.repoRoot, filePath)

			if (!file.includes("/lib/") || TEST_FILE.test(file)) continue

			const text = await readLocalTextFile(filePath)
			const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true)

			if (source.getLineAndCharacterOfPosition(source.end).line + 1 < MODULE_COHESION_THRESHOLDS.lines) continue

			const cohesion = moduleCohesion(source)

			if (cohesion.modularity < MODULE_COHESION_THRESHOLDS.modularity) continue

			const [pair] = cohesion.disjointPairs

			if (!pair) continue

			const [left, right] = pair

			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				message: `${cohesion.communities.length} declaration communities, modularity ${cohesion.modularity.toFixed(2)}; ${describe(left)} while ${describe(right)} — each group reads what the other never does, so one of them can move to its own module`,
				file,
				line: right.line,
			})
		}

		return diagnostics
	},
}
