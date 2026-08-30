/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Monotonic debt counters for patterns that are too contextual for a blanket lint error.
 *
 * Existing debt is recorded in `repo-health-baseline.json`; CI rejects growth. Run with
 * `--write-baseline` only after reviewing a deliberate reduction. Never raise a counter to make a
 * failure disappear.
 */

import { readLocalTextFile, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExistsSync } from "@mailwoman/core/fs/readers-sync"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/utils"
import { execFileSync } from "@mailwoman/platform/child_process"
import { relative, resolve } from "@mailwoman/platform/path"
import { parseArgs } from "@mailwoman/platform/util"
import ts from "typescript"

interface DebtCounters {
	asNever: number
	doubleCast: number
	deepRelativeImports: number
	filterBoolean: number
	productionFilesOver1000Lines: number
	selfPackageImports: number
	synchronousFilesystemCalls: number
}

const root = String(repoRootPath())
const baselinePath = resolve(root, "scripts/repo-health-baseline.json")

function emptyCounters(): DebtCounters {
	return {
		asNever: 0,
		doubleCast: 0,
		deepRelativeImports: 0,
		filterBoolean: 0,
		productionFilesOver1000Lines: 0,
		selfPackageImports: 0,
		synchronousFilesystemCalls: 0,
	}
}

/**
 * Unwrap the array/readonly/parenthesized wrappers a cast target can carry, so the check sees the type the author
 * actually named. `x as never[]` is an `ArrayTypeNode` whose element is the keyword, and it is exactly as unchecked as
 * the bare form.
 */
function unwrapTypeNode(type: ts.TypeNode): ts.TypeNode {
	if (ts.isArrayTypeNode(type)) return unwrapTypeNode(type.elementType)

	if (ts.isParenthesizedTypeNode(type)) return unwrapTypeNode(type.type)

	if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) {
		return unwrapTypeNode(type.type)
	}

	return type
}

function isNeverCast(node: ts.Node): boolean {
	return ts.isAsExpression(node) && unwrapTypeNode(node.type).kind === ts.SyntaxKind.NeverKeyword
}

function isUnknownCast(node: ts.Node): node is ts.AsExpression {
	return ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.UnknownKeyword
}

function isDeepRelativeSpecifier(value: string): boolean {
	return /^(?:[.][.]\/){3}/.test(value)
}

function isSelfPackageSpecifier(value: string, packageName: string | undefined): boolean {
	return packageName !== undefined && (value === packageName || value.startsWith(`${packageName}/`))
}

/**
 * The synchronous `node:fs` surface, by name.
 *
 * A `*Sync` suffix over-matches: `execSync`, `spawnSync`, `deflateSync` and `flushSync` are not filesystem calls, and
 * `@mailwoman/core/fs/readers-sync` deliberately exports its own `*Sync` helpers, which ARE the sanctioned idiom and
 * must not count against it. Only the builtin names belong here.
 */
const SYNCHRONOUS_FILESYSTEM_CALLS = new Set([
	"accessSync",
	"appendFileSync",
	"chmodSync",
	"closeSync",
	"copyFileSync",
	"cpSync",
	"existsSync",
	"globSync",
	"lstatSync",
	"mkdirSync",
	"mkdtempSync",
	"openSync",
	"readFileSync",
	"readSync",
	"readdirSync",
	"readlinkSync",
	"realpathSync",
	"renameSync",
	"rmSync",
	"rmdirSync",
	"statSync",
	"symlinkSync",
	"unlinkSync",
	"utimesSync",
	"writeFileSync",
	"writeSync",
])

/**
 * Whether a call reaches the synchronous filesystem directly, bypassing `@mailwoman/core/fs`.
 *
 * The baseline is SEVEN, and every one is in a workspace that does not depend on `@mailwoman/core` — `api-kit`,
 * `nuts-lookup`, `timezone-lookup`, `un-locode-lookup`, `variant-aliases`. Reaching the idiom would install core's ~9
 * MB of data into a small alias table and three lookups, so they keep the mirror and `oxlint.config.ts` exempts them by
 * name. They collapse to zero the day the fs helpers can be reached without that tarball; until then the number stays
 * checkable, and an eighth call anywhere fails this check.
 *
 * A bare identifier is counted; a property access is counted only when the receiver is spelled `fs`. That receiver rule
 * is what separates this population from two unrelated ones that share a method name: `node:sqlite`'s
 * `DatabaseSync.closeSync()`, and an INJECTED dependency (`deps.existsSync`), which is a parameter a test substitutes
 * rather than a filesystem call the module makes.
 */
function isSynchronousFilesystemCall(node: ts.Node): boolean {
	if (!ts.isCallExpression(node)) return false

	if (ts.isIdentifier(node.expression)) return SYNCHRONOUS_FILESYSTEM_CALLS.has(node.expression.text)

	return (
		ts.isPropertyAccessExpression(node.expression) &&
		ts.isIdentifier(node.expression.expression) &&
		node.expression.expression.text === "fs" &&
		SYNCHRONOUS_FILESYSTEM_CALLS.has(node.expression.name.text)
	)
}

function visit(
	source: ts.SourceFile,
	counters: DebtCounters,
	packageName: string | undefined,
	countSelfPackageImports: boolean,
	countSynchronousFilesystemCalls: boolean
): void {
	function walk(node: ts.Node): void {
		if (countSynchronousFilesystemCalls && isSynchronousFilesystemCall(node)) {
			counters.synchronousFilesystemCalls++
		}

		if (isNeverCast(node)) {
			counters.asNever++
		}

		if (ts.isAsExpression(node) && isUnknownCast(node.expression)) {
			counters.doubleCast++
		}

		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			isDeepRelativeSpecifier(node.moduleSpecifier.text)
		) {
			counters.deepRelativeImports++
		}

		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			countSelfPackageImports &&
			isSelfPackageSpecifier(node.moduleSpecifier.text, packageName)
		) {
			counters.selfPackageImports++
		}

		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0]!) &&
			isDeepRelativeSpecifier(node.arguments[0]!.text)
		) {
			counters.deepRelativeImports++
		}

		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0]!) &&
			countSelfPackageImports &&
			isSelfPackageSpecifier(node.arguments[0]!.text, packageName)
		) {
			counters.selfPackageImports++
		}

		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "filter" &&
			node.arguments.length === 1 &&
			ts.isIdentifier(node.arguments[0]!) &&
			node.arguments[0]!.text === "Boolean"
		) {
			counters.filterBoolean++
		}

		ts.forEachChild(node, walk)
	}

	walk(source)
}

/**
 * Directories whose sources count toward repository debt.
 */
const TRACKED_ROOTS = ["packages/", "scripts/", "docs/src/"]

/**
 * The TRACKED `.ts`/`.tsx` sources, which is what "repository debt" has to mean.
 *
 * Enumerated from the INDEX, not the filesystem. A counter read off the disk is not a property of the repository — it
 * is a property of whichever files happen to be sitting in that checkout. A tree carrying gitignored scratch scripts
 * under `scripts/diagnostic/` counted 166 `asNever` against a clean checkout's 85 at the SAME commit, and the gate
 * failed on files no commit contains. Two readers of this number must be able to reproduce each other.
 */
function trackedSourcePaths(): string[] {
	const listed = execFileSync("git", ["ls-files", "-z", "--", "*.ts", "*.tsx"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	})

	return listed
		.split("\0")
		.filter((relativePath) => relativePath.length > 0)
		.filter((relativePath) => TRACKED_ROOTS.some((prefix) => relativePath.startsWith(prefix)))
		.filter((relativePath) => !/(?:^|\/)(?:out|node_modules)\//.test(relativePath))
		.filter((relativePath) => !relativePath.endsWith(".d.ts"))
		.map((relativePath) => resolve(root, relativePath))
}

// A tracked path can be absent from the working tree (a deletion staged but not committed); skip it
// rather than failing the whole gate on a file the next commit removes anyway.
const paths = trackedSourcePaths().filter((path) => pathExistsSync(path))

const counters = emptyCounters()
const rootManifest = await readLocalJSONFile<{ workspaces: string[] }>(resolve(root, "package.json"))

const workspacePackages = await Promise.all(
	rootManifest.workspaces.map(async (workspace) => ({
		directory: resolve(root, workspace),
		name: (await readLocalJSONFile<{ name: string }>(resolve(root, workspace, "package.json"))).name,
	}))
)

for (const path of paths) {
	const text = await readLocalTextFile(path)

	const source = ts.createSourceFile(
		path,
		text,
		ts.ScriptTarget.Latest,
		false,
		path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	)

	const workspacePackage = workspacePackages.find(({ directory }) => path.startsWith(`${directory}/`))

	// Package tests intentionally import their own package name: that is the contract this repository's
	// test layout verifies. Self-imports remain debt in production source, where `#imports` avoid cycles/noise.
	const countSelfPackageImports = !path.includes("/test/")

	// `@mailwoman/platform/fs` is the runtime mirror and `@mailwoman/core/fs` is the idiom itself; both call the
	// builtins on purpose, and counting them would make the number measure the implementation rather than its callers.
	const countSynchronousFilesystemCalls =
		!path.startsWith(`${root}/packages/platform/`) && !path.startsWith(`${root}/packages/core/fs/`)

	visit(source, counters, workspacePackage?.name, countSelfPackageImports, countSynchronousFilesystemCalls)

	const lineCount = (text.match(/\n/g)?.length ?? 0) + 1
	const generated = /(?:@generated|This file was generated by:)/.test(text.slice(0, 1000))

	if (!generated && !/[.]test[.]tsx?$/.test(path) && lineCount > 1000) {
		counters.productionFilesOver1000Lines++
	}
}

// The key IS the flag text parseArgs matches, so it must stay kebab-case: `package.json`'s `health:debt:update`
// invokes this with `--write-baseline`, and a camelCase key rejects that as an unknown option.
const { values } = parseArgs({
	options: {
		"write-baseline": { type: "boolean", default: false },
	},
})

if (values["write-baseline"]) {
	await writeLocalJSONFile(counters, baselinePath)

	process.stdout.write(`Updated ${relative(root, baselinePath)}\n`)
} else {
	const baseline = await readLocalJSONFile<DebtCounters>(baselinePath)
	const regressions = Object.entries(counters).filter(([name, count]) => count > baseline[name as keyof DebtCounters])

	for (const [name, count] of Object.entries(counters)) {
		process.stdout.write(`${name}: ${count} (baseline ${baseline[name as keyof DebtCounters]})\n`)
	}

	if (regressions.length) {
		throw new Error(
			`Repository debt grew: ${regressions.map(([name, count]) => `${name} ${baseline[name as keyof DebtCounters]} → ${count}`).join(", ")}`
		)
	}
}
