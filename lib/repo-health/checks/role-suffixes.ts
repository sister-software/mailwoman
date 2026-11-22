// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file An exported class whose name ends in a role suffix declares that role in its `extends` or `implements` clause.
 *
 *   Three suffixes state a role a reader relies on:
 *
 *   - `Client` is an HTTP client, and it extends `APIClient`.
 *   - `Provider` hands out one of several handles by key, and it implements an interface whose name ends in `Provider`.
 *   - `Resolver` turns a parsed address into gazetteer entities, and it implements `Resolver`.
 *
 *   A class that reads one database or binary artifact by key is a lookup, and takes the `Lookup` suffix.
 *
 *   The test is syntactic: it reads the heritage clauses and resolves no types.
 *   A class whose role the clauses can't state keeps its name behind a reason, on the line above the declaration:
 *
 *       // repo-health-ignore role-suffixes -- <reason>
 */

import { relative } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#repo-health/check"
import { parseContextSource, readContextSources } from "#repo-health/context"
import { PACKAGE_SOURCE_GLOBS, trackedSourcePaths } from "#repo-health/tracked-sources"

/**
 * The comment marker that keeps a class's name, followed by the reason.
 */
const ROLE_IGNORE_MARKER = "repo-health-ignore role-suffixes --"

interface RoleRule {
	suffix: string

	/**
	 * What the class must declare, as a sentence fragment for the diagnostic.
	 */
	requirement: string

	/**
	 * Whether the heritage names satisfy the role.
	 */
	satisfied(heritage: { extended: readonly string[]; implemented: readonly string[] }): boolean

	/**
	 * Class names that are themselves the role's base and declare zero heritage of it.
	 */
	bases: readonly string[]
}

const ROLE_RULES: readonly RoleRule[] = [
	{
		suffix: "Client",
		requirement: "extends `APIClient`",
		satisfied: ({ extended }) => extended.includes("APIClient"),
		// `DatabaseClient` is the Kysely client and `GitClient` runs the git binary.
		// Neither speaks HTTP.
		bases: ["APIClient", "DatabaseClient", "GitClient"],
	},
	{
		suffix: "Provider",
		requirement: "implements an interface whose name ends in `Provider`",
		satisfied: ({ implemented }) => implemented.some((name) => name.endsWith("Provider")),
		bases: [],
	},
	{
		suffix: "Resolver",
		requirement: "implements `Resolver`, or takes the `Lookup` suffix when it reads one artifact by key",
		satisfied: ({ implemented }) => implemented.includes("Resolver"),
		bases: [],
	},
]

/**
 * Each type a heritage clause of `kind` lists, as written and without its type arguments.
 */
function heritageNames(source: ts.SourceFile, declaration: ts.ClassDeclaration, kind: ts.SyntaxKind): string[] {
	return (declaration.heritageClauses ?? [])
		.filter((clause) => clause.token === kind)
		.flatMap((clause) => clause.types.map((type) => type.expression.getText(source)))
}

function keepsItsName(text: string, declaration: ts.ClassDeclaration): boolean {
	const leading = ts.getLeadingCommentRanges(text, declaration.getFullStart()) ?? []

	// A formatter re-wraps a long comment, so the marker is matched with line breaks collapsed.
	return leading.some((range) =>
		text
			.slice(range.pos, range.end)
			.replaceAll(/\s*\n\s*(?:\/\/|\*)?\s*/gu, " ")
			.includes(ROLE_IGNORE_MARKER)
	)
}

/**
 * The diagnostics for one parsed module.
 */
function roleSuffixDiagnostics(file: string, source: ts.SourceFile): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	const text = source.getFullText()

	for (const statement of source.statements) {
		if (!ts.isClassDeclaration(statement) || !statement.name) continue

		if (!(ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue

		const name = statement.name.text
		const rule = ROLE_RULES.find((entry) => name.endsWith(entry.suffix))

		if (!rule || rule.bases.includes(name) || keepsItsName(text, statement)) continue

		const heritage = {
			extended: heritageNames(source, statement, ts.SyntaxKind.ExtendsKeyword),
			implemented: heritageNames(source, statement, ts.SyntaxKind.ImplementsKeyword),
		}

		if (rule.satisfied(heritage)) continue

		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			file,
			line: source.getLineAndCharacterOfPosition(statement.name.getStart(source)).line + 1,
			message: `\`${name}\` ends in \`${rule.suffix}\`, and a class with that suffix ${rule.requirement}. Rename the class or declare the role, or keep the name behind \`// ${ROLE_IGNORE_MARKER} <reason>\`.`,
			details: null,
		})
	}

	return diagnostics
}

/**
 * The `role-suffixes` check: one error for each exported class whose name ends in a
 * role suffix and whose heritage clauses don't declare the role.
 */
export const roleSuffixesCheck: RepoCheck = {
	id: "role-suffixes",
	description:
		"An exported class named *Client, *Provider or *Resolver declares that role in its extends or implements clause.",
	async run(context: RepoContext) {
		const paths = (
			await trackedSourcePaths(context, {
				globs: PACKAGE_SOURCE_GLOBS.filter((glob) => glob.endsWith(".ts")),
				existingOnly: true,
			})
		).filter((path) => {
			const file = relative(context.repoRoot, path)

			return !file.endsWith(".d.ts") && !file.endsWith(".test.ts")
		})

		await readContextSources(context, paths)

		const diagnostics: Diagnostic[] = []

		for (const path of paths) {
			const source = await parseContextSource(context, path, { scriptKind: ts.ScriptKind.TS })

			diagnostics.push(...roleSuffixDiagnostics(relative(context.repoRoot, path), source))
		}

		return diagnostics
	},
}
