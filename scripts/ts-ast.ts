/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The one TS-AST import-specifier walk the source-level guards share.
 */

import ts from "typescript"

export interface ModuleSpecifierOptions {
	/**
	 * Keep declaration-level type-only specifiers: `import type` / `export type` declarations and `import("x")` type
	 * positions. Node's type stripping erases those, so a guard about what RUNS leaves them out (`docs/sidebars.ts`
	 * relies on that — it takes a Docusaurus type with no install); a guard about the package CONTRACT keeps them. A
	 * specifier-level `{ type Foo }` still emits the declaration and is collected either way.
	 */
	includeTypeOnly?: boolean
}

/**
 * Every module specifier `source` imports, re-exports, or dynamically imports, in document order.
 *
 * String-literal-LIKE specifiers are collected — a no-substitution template literal counts, since `` import(`./x.ts`)
 * `` resolves exactly as the quoted form does.
 */
export function moduleSpecifiers(source: ts.SourceFile, options: ModuleSpecifierOptions = {}): string[] {
	const specifiers: string[] = []

	const visit = (node: ts.Node): void => {
		let specifier: ts.Expression | undefined

		if (ts.isImportDeclaration(node)) {
			// `phaseModifier` rather than the deprecated `isTypeOnly`: it also distinguishes `import defer`, which runs.
			if (options.includeTypeOnly || node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword) {
				specifier = node.moduleSpecifier
			}
		} else if (ts.isExportDeclaration(node)) {
			if (options.includeTypeOnly || !node.isTypeOnly) {
				specifier = node.moduleSpecifier
			}
		} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			specifier = node.arguments[0]
		} else if (options.includeTypeOnly && ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
			specifier = node.argument.literal
		}

		if (specifier && ts.isStringLiteralLike(specifier)) {
			specifiers.push(specifier.text)
		}

		ts.forEachChild(node, visit)
	}

	visit(source)

	return specifiers
}
