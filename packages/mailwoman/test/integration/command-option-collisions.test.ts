/**
 * Guard command-owned flags against root-owned --help/--version and -h/-v.
 */

import { workspacePath } from "@mailwoman/core/utils"
import { readFile, readdir } from "@mailwoman/platform/fs/promises"
import { join, relative, sep } from "@mailwoman/platform/path"
import ts from "typescript"
import { describe, expect, test } from "vitest"

const RESERVED_FLAGS = new Set(["version", "help"])
const RESERVED_ALIASES = new Set(["v", "h"])
const COMMAND_ROOTS = [workspacePath("mailwoman", "commands"), workspacePath("mailwoman", "cli-native", "commands")]

async function listCommandModules(): Promise<string[]> {
	const files: string[] = []

	for (const root of COMMAND_ROOTS) {
		for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
			if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name) && !entry.name.endsWith(".test.ts")) {
				files.push(join(entry.parentPath, entry.name))
			}
		}
	}

	return files.toSorted()
}

function unwrap(expression: ts.Expression): ts.Expression {
	let current = expression

	while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
		current = current.expression
	}

	return current
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
	return property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
		? property.name.text
		: undefined
}

function commandSpec(source: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
			continue

		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "spec" || !declaration.initializer) continue
			const expression = unwrap(declaration.initializer)

			if (ts.isObjectLiteralExpression(expression)) return expression
		}
	}

	return undefined
}

describe("command option names never collide with root flags", () => {
	test("every command has an inspectable spec with no reserved flags", async () => {
		const collisions: string[] = []
		const missing: string[] = []

		for (const file of await listCommandModules()) {
			const text = await readFile(file, "utf8")

			if (!/export default |export async function run/u.test(text)) continue

			const source = ts.createSourceFile(
				file,
				text,
				ts.ScriptTarget.ESNext,
				true,
				file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
			)

			const spec = commandSpec(source)

			const commandPath = COMMAND_ROOTS.map((root) => relative(root, file))
				.find((path) => !path.startsWith(".."))!
				.replace(/\.(?:ts|tsx)$/u, "")
				.split(sep)
				.join(" ")

			if (!spec) {
				missing.push(commandPath)

				continue
			}

			const optionsProperty = spec.properties.find((property) => propertyName(property) === "options")

			if (!optionsProperty || !ts.isPropertyAssignment(optionsProperty)) continue
			const options = unwrap(optionsProperty.initializer)

			if (!ts.isObjectLiteralExpression(options)) {
				missing.push(`${commandPath}: options is not an object literal`)

				continue
			}

			for (const option of options.properties) {
				const name = propertyName(option)

				if (name && RESERVED_FLAGS.has(name)) {
					collisions.push(`${commandPath}: --${name}`)
				}

				if (!ts.isPropertyAssignment(option)) continue
				const descriptor = unwrap(option.initializer)

				if (!ts.isObjectLiteralExpression(descriptor)) continue
				const short = descriptor.properties.find((property) => propertyName(property) === "short")

				if (
					short &&
					ts.isPropertyAssignment(short) &&
					ts.isStringLiteral(short.initializer) &&
					RESERVED_ALIASES.has(short.initializer.text)
				) {
					collisions.push(`${commandPath}: -${short.initializer.text}`)
				}
			}
		}

		expect(missing).toEqual([])
		expect(collisions).toEqual([])
	})
})
