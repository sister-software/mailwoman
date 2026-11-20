// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file What one module exports, re-exports and imports, read from its syntax tree with every specifier resolved.
 *
 *   The `test-only-exports` check joins these facts across the tree into an import graph.
 */

import ts from "typescript"

/**
 * A name that stands for every export of a module: a namespace import,
 * `export * as`, or an unshaped `import()`.
 */
export const EVERY_EXPORT = "*"

/**
 * The JSDoc tag knip reads as public interface.
 * Knip never reports an export tagged with it.
 */
const PUBLIC_TAG = "public"

/**
 * The most loader calls and local loader functions a destructured `import()` is followed through.
 * The bound ends a loader function that calls itself.
 */
const LOADER_DEPTH = 4

/**
 * Calls that resolve to the module objects of the imports they wrap, in the shape of the literal they take.
 */
const LOADER_CALLS: ReadonlySet<string> = new Set(["Promise.all", "allKeyed"])

/**
 * One exported declaration, as its module states it.
 */
interface DeclaredExport {
	line: number
	publicTag: boolean
	/**
	 * Referenced in its own module outside its declaration.
	 */
	usedInModule: boolean
}

/**
 * A name a module re-exports from another: `export { a as b } from "x"`,
 * or `import { a } from "x"; export { a }`.
 */
interface ReExport {
	target: string
	name: string
}

/**
 * Names one module takes from another. {@linkcode EVERY_EXPORT} stands for all of them.
 */
interface ModuleUse {
	target: string
	names: string[]
}

/**
 * What one module declares, re-exports and imports, with specifiers resolved to repo-relative files.
 */
export interface ModuleFacts {
	declared: Map<string, DeclaredExport>
	reExports: Map<string, ReExport>
	stars: string[]
	uses: ModuleUse[]
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
}

function hasPublicTag(node: ts.Node): boolean {
	const target = ts.isVariableDeclaration(node) ? node.parent.parent : node

	return ts.getJSDocTags(target).some((tag) => tag.tagName.text === PUBLIC_TAG)
}

/**
 * The identifiers a binding name declares: `a`, or each leaf of `{ a, b: [c] }`.
 */
function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
	if (ts.isIdentifier(name)) return [name]

	return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name)))
}

/**
 * The number of references to each name in `source`.
 *
 * Declaration names, import and export specifiers, and property names after a dot
 * or before a colon aren't counted.
 */
function referenceCounts(source: ts.SourceFile, declarationNames: ReadonlySet<ts.Node>): Map<string, number> {
	const counts = new Map<string, number>()

	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return

		if (ts.isIdentifier(node)) {
			if (!declarationNames.has(node)) {
				counts.set(node.text, (counts.get(node.text) ?? 0) + 1)
			}

			return
		}

		if (ts.isPropertyAccessExpression(node)) return visit(node.expression)

		if (ts.isQualifiedName(node)) return visit(node.left)

		if (
			(ts.isPropertyAssignment(node) ||
				ts.isPropertyDeclaration(node) ||
				ts.isPropertySignature(node) ||
				ts.isMethodDeclaration(node) ||
				ts.isMethodSignature(node) ||
				ts.isEnumMember(node) ||
				ts.isGetAccessor(node) ||
				ts.isSetAccessor(node)) &&
			ts.isIdentifier(node.name)
		) {
			ts.forEachChild(node, (child) => {
				if (child !== node.name) {
					visit(child)
				}
			})

			return
		}

		ts.forEachChild(node, visit)
	}

	visit(source)

	return counts
}

function isDynamicImport(
	node: ts.Node
): node is ts.CallExpression & { arguments: readonly [ts.StringLiteralLike, ...ts.Expression[]] } {
	return (
		ts.isCallExpression(node) &&
		node.expression.kind === ts.SyntaxKind.ImportKeyword &&
		node.arguments[0] != null &&
		ts.isStringLiteralLike(node.arguments[0])
	)
}

/**
 * The expression body of `const name = () => expression` at module level.
 */
function moduleArrowBody(source: ts.SourceFile, name: string): ts.Expression | null {
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue

		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue

			const initializer = declaration.initializer

			if (initializer && ts.isArrowFunction(initializer) && !ts.isBlock(initializer.body)) {
				return initializer.body
			}
		}
	}

	return null
}

/**
 * The expression a destructuring reads.
 *
 * `await`, parentheses and a loader call are stripped.
 * A call to a module-level arrow function is replaced by the expression it returns.
 */
function unwrapLoader(expression: ts.Expression, source: ts.SourceFile, depth = 0): ts.Expression {
	if (depth > LOADER_DEPTH) return expression

	if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression)) {
		return unwrapLoader(expression.expression, source, depth + 1)
	}

	if (!ts.isCallExpression(expression) || isDynamicImport(expression)) return expression

	const callee = expression.expression.getText(source)
	const [argument] = expression.arguments

	if (LOADER_CALLS.has(callee) && argument && expression.arguments.length === 1) {
		return unwrapLoader(argument, source, depth + 1)
	}

	if (ts.isIdentifier(expression.expression) && !expression.arguments.length) {
		const loader = moduleArrowBody(source, expression.expression.text)

		if (loader) return unwrapLoader(loader, source, depth + 1)
	}

	return expression
}

function isDeclarationName(node: ts.Identifier): boolean {
	const parent = node.parent

	if (!parent) return false

	if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true

	if (ts.isExportSpecifier(parent)) return true

	return (
		(ts.isVariableDeclaration(parent) ||
			ts.isBindingElement(parent) ||
			ts.isParameter(parent) ||
			ts.isFunctionDeclaration(parent) ||
			ts.isClassDeclaration(parent) ||
			ts.isInterfaceDeclaration(parent) ||
			ts.isTypeAliasDeclaration(parent)) &&
		parent.name === node
	)
}

/**
 * How each name in a module is read: the members taken from it with `name.member`,
 * and whether it's also used whole.
 *
 * A declaration's own name is neither.
 */
function memberAccesses(source: ts.SourceFile): Map<string, { members: Set<string>; whole: boolean }> {
	const accesses = new Map<string, { members: Set<string>; whole: boolean }>()

	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && !isDeclarationName(node)) {
			const access = accesses.get(node.text) ?? { members: new Set<string>(), whole: false }
			const parent = node.parent

			if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
				access.members.add(parent.name.text)
			} else if (parent && ts.isQualifiedName(parent) && parent.left === node) {
				access.members.add(parent.right.text)
			} else if (!(parent && ts.isPropertyAccessExpression(parent) && parent.name === node)) {
				access.whole = true
			}

			accesses.set(node.text, access)
		}

		ts.forEachChild(node, visit)
	}

	visit(source)

	return accesses
}

function leftmostIdentifier(name: ts.QualifiedName): ts.Identifier {
	return ts.isIdentifier(name.left) ? name.left : leftmostIdentifier(name.left)
}

/**
 * The facts of one module parsed with parent nodes set.
 *
 * `resolve` answers the repo-relative file a specifier resolves to, or `undefined`.
 */
export function moduleFacts(source: ts.SourceFile, resolve: (specifier: string) => string | undefined): ModuleFacts {
	const declared = new Map<string, DeclaredExport>()
	const reExports = new Map<string, ReExport>()
	const stars: string[] = []
	const uses: ModuleUse[] = []
	const declarationNames = new Set<ts.Node>()
	/**
	 * Local declarations, so `export { local }` finds its line.
	 */
	const locals = new Map<string, ts.Node>()
	/**
	 * Imported bindings, so `export { binding }` becomes a re-export rather than a declaration.
	 */
	const imported = new Map<string, ReExport>()
	const exportedLocals: Array<{ exported: string; local: string; node: ts.Node }> = []
	const declaredNodes = new Map<string, { node: ts.Node; name: ts.Node }>()

	const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

	const declare = (exported: string, node: ts.Node, name: ts.Node): void => {
		declarationNames.add(name)

		// An overload or a merged declaration keeps the first site.
		if (!declaredNodes.has(exported)) {
			declaredNodes.set(exported, { node, name })
		}
	}

	for (const statement of source.statements) {
		if (ts.isImportDeclaration(statement)) {
			if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue

			const target = resolve(statement.moduleSpecifier.text)
			const clause = statement.importClause

			if (!target || !clause) continue

			if (clause.name) {
				imported.set(clause.name.text, { target, name: "default" })
			}

			const bindings = clause.namedBindings

			if (bindings && ts.isNamespaceImport(bindings)) {
				imported.set(bindings.name.text, { target, name: EVERY_EXPORT })
			} else if (bindings) {
				for (const element of bindings.elements) {
					imported.set(element.name.text, { target, name: (element.propertyName ?? element.name).text })
				}
			}

			continue
		}

		if (ts.isExportDeclaration(statement)) {
			const specifier = statement.moduleSpecifier

			if (specifier) {
				if (!ts.isStringLiteralLike(specifier)) continue

				const target = resolve(specifier.text)

				if (!target) continue

				const clause = statement.exportClause

				if (!clause) {
					stars.push(target)
				} else if (ts.isNamespaceExport(clause)) {
					reExports.set(clause.name.text, { target, name: EVERY_EXPORT })
				} else {
					for (const element of clause.elements) {
						reExports.set(element.name.text, { target, name: (element.propertyName ?? element.name).text })
					}
				}
			} else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
				for (const element of statement.exportClause.elements) {
					exportedLocals.push({
						exported: element.name.text,
						local: (element.propertyName ?? element.name).text,
						node: element,
					})
				}
			}

			continue
		}

		if (ts.isExportAssignment(statement)) {
			declare("default", statement, statement)

			continue
		}

		const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword)
		const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword)

		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				for (const identifier of bindingIdentifiers(declaration.name)) {
					locals.set(identifier.text, declaration)

					if (exported) {
						declare(identifier.text, declaration, identifier)
					}
				}
			}

			continue
		}

		if (
			ts.isFunctionDeclaration(statement) ||
			ts.isClassDeclaration(statement) ||
			ts.isInterfaceDeclaration(statement) ||
			ts.isTypeAliasDeclaration(statement) ||
			ts.isEnumDeclaration(statement) ||
			ts.isModuleDeclaration(statement)
		) {
			const name = statement.name

			if (name && ts.isIdentifier(name)) {
				locals.set(name.text, statement)

				// Every overload and merged declaration declares the same binding.
				if (exported) {
					declarationNames.add(name)
				}
			}

			if (exported && isDefault) {
				declare("default", statement, name ?? statement)
			} else if (exported && name && ts.isIdentifier(name)) {
				declare(name.text, statement, name)
			}
		}
	}

	const references = referenceCounts(source, declarationNames)

	for (const { exported, local, node } of exportedLocals) {
		const binding = imported.get(local)
		const declaration = locals.get(local)

		if (binding) {
			reExports.set(exported, binding)
		} else if (declaration && !declaredNodes.has(exported)) {
			declaredNodes.set(exported, { node: declaration, name: node })
		}
	}

	for (const [exported, { node }] of declaredNodes) {
		const locallyNamed = locals.has(exported) || exported === "default"

		declared.set(exported, {
			line: lineOf(node),
			publicTag: hasPublicTag(node),
			usedInModule: locallyNamed && (references.get(exported) ?? 0) > 0,
		})
	}

	// An imported binding counts as a use where the module refers to it.
	// A binding the module only re-exports is a re-export, followed when the re-exporting module is imported.
	const byTarget = new Map<string, Set<string>>()

	const take = (target: string, name: string): void => {
		const names = byTarget.get(target) ?? new Set<string>()

		names.add(name)
		byTarget.set(target, names)
	}

	const accesses = memberAccesses(source)

	/**
	 * The names read from the module object bound to `local`: each `local.name`.
	 * Every export when `local` is passed on whole.
	 */
	const namesReadFrom = (local: string): string[] => {
		const access = accesses.get(local)

		if (!access) return []

		return access.whole ? [EVERY_EXPORT] : [...access.members]
	}

	for (const [local, { target, name }] of imported) {
		if (!references.get(local)) continue

		const names = name === EVERY_EXPORT ? namesReadFrom(local) : [name]

		for (const read of names) {
			take(target, read)
		}
	}

	const shapedImports = new Set<ts.Node>()

	/**
	 * The exports a binding pattern reads from the module object it receives.
	 */
	const namesBoundBy = (name: ts.BindingName): string[] => {
		if (ts.isIdentifier(name)) return namesReadFrom(name.text)

		if (ts.isArrayBindingPattern(name)) return [EVERY_EXPORT]

		return name.elements.map((element) => {
			const property = element.propertyName ?? element.name

			return element.dotDotDotToken || !ts.isIdentifier(property) ? EVERY_EXPORT : property.text
		})
	}

	/**
	 * Matches a binding pattern against the expression it destructures, down to each `import()` it reaches.
	 *
	 * `const [{ a }] = await Promise.all([import("x")])` reads `a` from `x`.
	 * So does `const { k: { a } } = await allKeyed({ k: import("x") })`.
	 */
	const bindImports = (name: ts.BindingName, expression: ts.Expression): void => {
		const value = unwrapLoader(expression, source)

		if (isDynamicImport(value)) {
			const target = resolve(value.arguments[0].text)

			shapedImports.add(value)

			if (target) {
				for (const read of namesBoundBy(name)) {
					take(target, read)
				}
			}

			return
		}

		if (ts.isArrayBindingPattern(name) && ts.isArrayLiteralExpression(value)) {
			name.elements.forEach((element, index) => {
				const item = value.elements[index]

				if (ts.isBindingElement(element) && !element.dotDotDotToken && item && !ts.isSpreadElement(item)) {
					bindImports(element.name, item)
				}
			})

			return
		}

		if (!ts.isObjectBindingPattern(name) || !ts.isObjectLiteralExpression(value)) return

		for (const element of name.elements) {
			const property = element.propertyName ?? element.name

			if (element.dotDotDotToken || !ts.isIdentifier(property)) continue

			const assignment = value.properties.find(
				(candidate): candidate is ts.PropertyAssignment =>
					ts.isPropertyAssignment(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === property.text
			)

			if (assignment) {
				bindImports(element.name, assignment.initializer)
			}
		}
	}

	const bindVisit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && node.initializer) {
			bindImports(node.name, node.initializer)
		}

		ts.forEachChild(node, bindVisit)
	}

	bindVisit(source)

	const visit = (node: ts.Node): void => {
		if (isDynamicImport(node)) {
			const target = shapedImports.has(node) ? null : resolve(node.arguments[0].text)

			if (target) {
				take(target, EVERY_EXPORT)
			}
		} else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteralLike(node.argument.literal)
		) {
			const target = resolve(node.argument.literal.text)
			const qualifier = node.qualifier
			const first = qualifier && (ts.isIdentifier(qualifier) ? qualifier : leftmostIdentifier(qualifier))

			if (target) {
				take(target, first ? first.text : EVERY_EXPORT)
			}
		}

		ts.forEachChild(node, visit)
	}

	visit(source)

	for (const [target, names] of byTarget) {
		uses.push({ target, names: [...names] })
	}

	return { declared, reExports, stars, uses }
}
