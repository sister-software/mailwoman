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

import { pathExists, readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
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
 * A `*Sync` suffix over-matches: `execSync`, `spawnSync`, `deflateSync` and `flushSync` are not filesystem calls. The
 * synchronous helper modules (`@mailwoman/core/fs/readers-sync` / `writers-sync`) no longer exist — importing either is
 * itself a finding and is counted separately. Only the builtin names belong here.
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
 * The baseline is ZERO and the policy is absolute: no executable repository code may make a blocking filesystem call.
 * The direct mirror call sites that once survived this check (`api-kit`'s document emit, `variant-aliases`' table
 * probe, `train_with_resume`'s log descriptor) all await the async surface now, and the platform mirror no longer
 * re-exports the `*Sync` names at all.
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
	countSelfPackageImports: boolean
): void {
	function walk(node: ts.Node): void {
		if (isSynchronousFilesystemCall(node)) {
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
			/(?:readers-sync|writers-sync)(?:[/"]|$)/.test(node.moduleSpecifier.text)
		) {
			counters.synchronousFilesystemCalls++
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
 * Paths whose sources DO NOT count toward repository debt, and why each is excluded.
 *
 * The counters used to enumerate three roots — `packages/`, `scripts/`, `docs/src/` — which quietly excluded
 * `codemods/`, `corpus-python/`, `docker/`, everything in `docs/` outside `src/`, and the root-level configs. That is a
 * denominator, and a count reported without one says less than it appears to: `synchronousFilesystemCalls` read 7 while
 * `corpus-python/scripts/train_with_resume.ts` held an eighth call the walk never opened. The set is now every tracked
 * `.ts`/`.tsx`, minus what is listed here.
 */
const UNCOUNTED = [
	// The runtime mirror and the idiom over it call the builtins on purpose; counting them would measure the
	// implementation rather than its callers.
	"packages/platform/",
	"packages/core/fs/",
	// A codemod fixture is an INPUT. `tests/*/input.ts` holds the synchronous shapes the transform consumes and
	// `expected.ts` holds the ones it deliberately refuses to touch, so both must keep calls this check dislikes.
	// The codemod's own `scripts/` are NOT excluded.
	"codemods/sync-fs-to-async/tests/",
]

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
		.filter((relativePath) => !UNCOUNTED.some((prefix) => relativePath.startsWith(prefix)))
		.filter((relativePath) => !/(?:^|\/)(?:out|node_modules)\//.test(relativePath))
		.filter((relativePath) => !relativePath.endsWith(".d.ts"))
		.map((relativePath) => resolve(root, relativePath))
}

// A tracked path can be absent from the working tree (a deletion staged but not committed); skip it
// rather than failing the whole gate on a file the next commit removes anyway.
const paths = (
	await Promise.all(trackedSourcePaths().map(async (path) => ((await pathExists(path)) ? path : undefined)))
).filter((path): path is string => path !== undefined)

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

	visit(source, counters, workspacePackage?.name, countSelfPackageImports)

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
