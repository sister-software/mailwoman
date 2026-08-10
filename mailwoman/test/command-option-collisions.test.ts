/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Guard for #1491: a command option whose name derives a flag the ROOT program already owns is
 *   silently swallowed — commander resolves the root's flag first, so the subcommand never runs and
 *   the process exits 0. There is no error to notice.
 *
 *   The reserved set comes straight from Pastel's own registration (pastel@4 `build/index.js`):
 *
 *   - `program.version(version, "-v, --version", "Show version number")` on the root program
 *   - `program.helpOption("-h, --help", "Show help")` on the root program, and
 *     `commanderCommand.helpOption("-h, --help", "Show help")` on every generated subcommand
 *
 *   Measured before the fix: `mailwoman corpus overlay-manifest --base a … --version 9.9.9 …`
 *   printed `8.7.0` and exited 0. `assembleOverlayManifest` was never called.
 *
 *   Pastel derives the flag from the schema key with `decamelize(name, {separator: "-"})`, which only
 *   ever splits camelCase humps — it never merges or drops words. So a key collides with `--version`
 *   / `--help` if and only if the key IS `version` / `help`, and comparing raw keys is exact rather
 *   than an approximation of the derivation.
 *
 *   WHY THIS READS SOURCE INSTEAD OF IMPORTING THE MODULES: the obvious implementation — dynamic
 *   `import()` of every `commands/**` module and read `options.shape` — does not survive contact with
 *   the root vitest alias table. `@mailwoman/corpus/(.+)` maps to `corpus/src/$1.ts`, so
 *   `@mailwoman/corpus/tools` (a DIRECTORY with an `index.ts`) fails to resolve and
 *   `commands/corpus/audit.tsx` throws on import. Parsing the source with the TypeScript AST costs
 *   ~a second, has no module-resolution surface at all, and cannot be broken by an alias-table
 *   change. The trade is that it only understands the shapes the tree actually uses — so an
 *   unrecognized shape is a FAILURE, never a skip (see `unparsed` below). A guard that silently
 *   stops looking is worse than no guard.
 *
 *   Sweep result at the time of writing: 133 command modules, 122 with an options schema, 1
 *   collision (the one above).
 */

import { readFile, readdir } from "node:fs/promises"
import { join, relative, sep } from "node:path"

import { repoRootPath } from "@mailwoman/core/utils"
import ts from "typescript"
import { describe, expect, test } from "vitest"

/**
 * Flag names Pastel/commander register outside any command's own schema.
 */
const RESERVED_FLAGS = new Set(["version", "help"])

/**
 * SHORT flags the root program owns, which a command claims via pastel's `option({ alias })`.
 *
 * The long-name rule above is not the whole hazard. Commander is left in its default mode — no
 * `enablePositionalOptions()` — so the ROOT scans the entire argv for its own options before a subcommand is dispatched
 * (`parseOptions`: the `_findCommand(arg)` early-break is gated on `_enablePositionalOptions`). Measured 2026-08-10
 * against commander 14 with pastel's exact registration order: a subcommand that declares `-v, --verbose` ITSELF still
 * loses — `<cli> doctor -v` prints the version number and exits 0, the same silent swallow #1491 documented for
 * `--version`.
 *
 * So an alias here is not "shadowed sometimes"; it never fires. `mailwoman doctor` carries the worked example in its
 * docstring, and ships `--verbose` with no short form because of this.
 */
const RESERVED_ALIASES = new Set(["v", "h"])

const COMMANDS_ROOT = repoRootPath("mailwoman", "commands")

/**
 * Every `.tsx` under `commands/` is a command module; `.test.ts` siblings are not.
 */
async function listCommandModules(): Promise<string[]> {
	const entries = await readdir(COMMANDS_ROOT, { recursive: true, withFileTypes: true })

	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
		.map((entry) => join(entry.parentPath, entry.name))
		.toSorted()
}

/**
 * Find the local identifier a module publishes as `options` — Pastel's contract. The tree writes this two ways: `export
 * { OptionsSchema as options }` (121 modules) and `export const options = ServerConfigSchema` (`commands/serve.tsx`).
 *
 * @returns The local name, or `undefined` when the module declares no options at all (valid — an argument-only or
 * flagless command).
 */
function findOptionsBinding(source: ts.SourceFile): string | undefined {
	for (const statement of source.statements) {
		if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
			for (const element of statement.exportClause.elements) {
				if (element.name.text === "options") return (element.propertyName ?? element.name).text
			}
		}

		if (
			ts.isVariableStatement(statement) &&
			statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
		) {
			for (const declaration of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "options") continue

				// `export const options = ServerConfigSchema` — follow the alias.
				if (declaration.initializer && ts.isIdentifier(declaration.initializer)) return declaration.initializer.text

				return "options"
			}
		}
	}

	return undefined
}

/**
 * The `zod.object({...})` initializer bound to `name` at module scope.
 */
function findSchemaObjectLiteral(source: ts.SourceFile, name: string): ts.ObjectLiteralExpression | undefined {
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue

		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue

			let expression: ts.Expression | undefined = declaration.initializer

			// Unwrap `zod.object({…}).optional()`, `.strict()`, and friends down to the `zod.object(…)` call.
			while (expression && ts.isCallExpression(expression)) {
				const [firstArgument] = expression.arguments

				if (firstArgument && ts.isObjectLiteralExpression(firstArgument)) return firstArgument

				expression = ts.isPropertyAccessExpression(expression.expression) ? expression.expression.expression : undefined
			}
		}
	}

	return undefined
}

/**
 * Property names declared on the schema literal, i.e. the keys Pastel decamelizes into flags.
 */
function optionNames(literal: ts.ObjectLiteralExpression): string[] {
	const names: string[] = []

	for (const property of literal.properties) {
		if (!property.name) continue

		if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
			names.push(property.name.text)
		}
	}

	return names
}

/**
 * Every single-letter alias the module hands pastel's `option({ alias: "x" })`, wherever it appears.
 *
 * Deliberately a whole-file walk rather than a schema walk: `option(...)` is only ever meaningful inside a
 * `.describe()` on an options-schema property, so any occurrence in a command module IS a declared alias, and finding
 * them by shape survives the schema being built somewhere this file's narrow schema parser cannot follow.
 */
function optionAliases(source: ts.SourceFile): string[] {
	const aliases: string[] = []

	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "option") {
			const [config] = node.arguments

			if (config && ts.isObjectLiteralExpression(config)) {
				for (const property of config.properties) {
					if (
						ts.isPropertyAssignment(property) &&
						property.name &&
						(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
						property.name.text === "alias" &&
						ts.isStringLiteral(property.initializer)
					) {
						aliases.push(property.initializer.text)
					}
				}
			}
		}

		ts.forEachChild(node, visit)
	}

	visit(source)

	return aliases
}

describe("command option names never collide with the root program's flags", () => {
	test("no commands/**/*.tsx option derives --version or --help", async () => {
		const files = await listCommandModules()

		// A zero-length sweep would pass vacuously and nobody would know the guard had gone blind.
		expect(files.length).toBeGreaterThan(100)

		const collisions: string[] = []
		const unparsed: string[] = []
		let schemasChecked = 0

		for (const file of files) {
			const commandPath = relative(COMMANDS_ROOT, file)
				.replace(/\.tsx$/, "")
				.split(sep)
				.join(" ")

			const text = await readFile(file, "utf8")
			const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)

			for (const alias of optionAliases(source)) {
				if (RESERVED_ALIASES.has(alias)) {
					collisions.push(`${commandPath}: alias -${alias} is owned by the root program and never reaches the command`)
				}
			}

			const binding = findOptionsBinding(source)

			// No options export at all — an argument-only command. Nothing to collide.
			if (!binding) continue

			const literal = findSchemaObjectLiteral(source, binding)

			if (!literal) {
				unparsed.push(`${commandPath}: exports \`${binding}\` as options, but its zod.object literal was not found`)

				continue
			}

			schemasChecked++

			for (const name of optionNames(literal)) {
				if (RESERVED_FLAGS.has(name)) {
					collisions.push(`${commandPath}: option \`${name}\` derives --${name}, which the root program owns`)
				}
			}
		}

		// A shape this parser cannot read is an unchecked command, not a passing one.
		expect(unparsed).toEqual([])
		expect(schemasChecked).toBeGreaterThan(100)
		expect(collisions).toEqual([])
	})
})
