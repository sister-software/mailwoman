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

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { repoRootPath } from "@mailwoman/core/utils"
import { relative, resolvePath } from "path-ts"
import ts from "typescript"

import { trackedSourcePaths } from "./tracked-sources.ts"

interface DebtCounters {
	asNever: number
	doubleCast: number
	deepRelativeImports: number
	filterBoolean: number
	productionFilesOver1000Lines: number
	selfPackageImports: number
	synchronousFilesystemCalls: number
	/**
	 * Occurrences of the word `shard` in any spelling, anywhere in tracked source — identifiers, comments and string
	 * literals alike.
	 *
	 * The vocabulary is being removed because the word stood for FOUR different things (corpus recipes, per-country
	 * postcode databases, WOF extracts, and the providers' region databases), so there is no replacement synonym — each
	 * site takes the noun for the thing it actually names. The target is ZERO, and this counter is the finish line:
	 * ratcheted down per PR, it can only fall.
	 *
	 * COUNTED HERE RATHER THAN WITH `grep` ON PURPOSE. Five tracked sources carry raw NUL bytes (#2018), which `grep`
	 * treats as binary and skips SILENTLY — no error, no count. Measured 2026-09-01: 3,481 occurrences with `grep -a`
	 * against 3,427 without, so a `grep`-based ratchet would hide 54 occurrences and could certify zero while they
	 * remained. `readLocalTextFile` has no such blind spot.
	 */
	shardVocabulary: number
}

const root = String(repoRootPath())
const baselinePath = resolvePath(root, "scripts/repo-health-baseline.json")

function emptyCounters(): DebtCounters {
	return {
		asNever: 0,
		doubleCast: 0,
		deepRelativeImports: 0,
		filterBoolean: 0,
		productionFilesOver1000Lines: 0,
		selfPackageImports: 0,
		synchronousFilesystemCalls: 0,
		shardVocabulary: 0,
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
 * A `*Sync` suffix over-matches: `execSync`, `spawnSync`, `deflateSync` and `flushSync` are not filesystem calls
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
 * The baseline is EIGHT, and each is named. Seven sit in workspaces that do not depend on `@mailwoman/core` — `api-kit`
 * (2), `nuts-lookup`, `timezone-lookup`, `un-locode-lookup`, `variant-aliases` (2) — where reaching the idiom would
 * install core's ~9 MB of data to replace a `mkdir` or a `readFileSync`. The eighth is
 * `corpus-python/scripts/train_with_resume.ts`'s `openSync(LOG, "a")`: a log DESCRIPTOR opened in append mode for a
 * child's stdio, which no path helper accepts. `oxlint.config.ts` exempts all eight files by name. They collapse the
 * day the fs helpers can be reached without core's tarball; until then a NINTH call anywhere fails this check.
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
 * The set is every tracked `.ts`/`.tsx` minus what is listed here — the denominator a count is reported against, and a
 * count reported without one says less than it appears to.
 */
const UNCOUNTED = [
	// The runtime mirror and the idiom over it call the builtins on purpose; counting them would measure the
	// implementation rather than its callers.
	"packages/core/lib/fs/",
]

// `existingOnly`: a tracked path can be absent from the working tree (a deletion staged but not
// committed); skip it rather than failing the whole gate on a file the next commit removes anyway.
// The enumerate-the-index rationale lives on scripts/tracked-sources.ts.
const paths = await trackedSourcePaths(root, { excludePrefixes: UNCOUNTED, existingOnly: true })

const counters = emptyCounters()
const rootManifest = await readLocalJSONFile<{ workspaces: string[] }>(resolvePath(root, "package.json"))

const workspacePackages = await Promise.all(
	rootManifest.workspaces.map(async (workspace) => ({
		directory: resolvePath(root, workspace),
		name: (await readLocalJSONFile<{ name: string }>(resolvePath(root, workspace, "package.json"))).name,
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

	// Textual, not AST: the word is being removed from comments and string literals as well as identifiers.
	counters.shardVocabulary += text.match(/\b[A-Za-z_]*shard[A-Za-z_]*\b/giu)?.length ?? 0
}

// The key IS the flag text parseArgs matches, so it must stay kebab-case: `package.json`'s `health:debt:update`
// invokes this with `--write-baseline`, and a camelCase key rejects that as an unknown option.
const { values } = parseArguments({
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
