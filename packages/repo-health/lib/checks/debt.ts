/**
 * Debt counters for patterns not covered by a simple lint rule.
 *
 * Counts are compared against `baseline.json`.
 * Higher counts fail.
 * Lower counts warn so the baseline can be ratcheted.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { relative, resolvePath } from "path-ts"
import { TextSpliterator } from "spliterator"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#check"
import { findDanglingLinks } from "#checks/doc-link-targets"
import { findAffixPairs } from "#checks/export-name-affix"
import { findPrivateNameShadows } from "#checks/private-name-shadows"
import { trackedSourcePaths } from "#tracked-sources"

export interface DebtCounters {
	/**
	 * Private functions shadowing exported names from other modules.
	 */
	privateNameShadows: number
	/**
	 * Export names that are longer affix forms of another exported name.
	 */
	exportNameAffix: number
	/**
	 * `{@link}` targets that do not exist in the repository.
	 */
	danglingDocLinks: number
	asNever: number
	doubleCast: number
	deepRelativeImports: number
	filterBoolean: number
	/**
	 * Non-generated, non-test source files over 1,000 lines of code.
	 *
	 * Comment and blank lines are excluded, so the count tracks what a file does
	 * rather than how its comments are laid out.
	 */
	productionFilesOver1000Lines: number
	selfPackageImports: number
	synchronousFilesystemCalls: number
	/**
	 * Raw NUL bytes in tracked TypeScript files.
	 */
	rawNULBytes: number
	/**
	 * Matches of the retired vocabulary pattern in tracked text.
	 */
	bannedVocabulary: number
	/**
	 * `stack.push(...node.children)` style manual tree walks.
	 */
	handRolledTreeWalks: number
}

/**
 * Counter names.
 */
export type DebtCounterKind = Extract<keyof DebtCounters, string>

/**
 * Path to the committed debt baseline.
 */
export const BASELINE_PATH = resolvePackagePath("@mailwoman/repo-health", "baseline.json")

/**
 * Repo-relative path to this file.
 */
const SELF = "packages/repo-health/lib/checks/debt.ts"

/**
 * Maximum code lines allowed for non-generated, non-test source files.
 */
const PRODUCTION_FILE_LINE_CEILING = 1000

/**
 * Lines of a source file that carry code, which is what {@link PRODUCTION_FILE_LINE_CEILING} bounds.
 *
 * A raw line count measures comment layout as much as file size.
 * This repository sets comments one sentence per line (`config/oxlint/comment-reflow`),
 * and adopting that layout took `packages/tiger/lib/class-code.ts` from 978 lines
 * to 1,088 without adding a member to its table.
 *
 * That file documents 164 Census feature-class codes in 167 lines of code.
 *
 * Block-comment state carries across lines, so a continuation line counts as comment however it begins.
 * A `//` or a block marker inside a string literal reads as a comment here,
 * which undercounts a file holding one.
 *
 * The ceiling is a size heuristic, and a few lines either way does not carry a file across 1,000.
 */
function codeLineCount(text: string): number {
	let count = 0
	let inBlock = false

	for (const rawLine of TextSpliterator.from(text)) {
		let rest = rawLine
		let code = ""

		while (rest !== "") {
			if (inBlock) {
				const end = rest.indexOf("*/")

				if (end === -1) break

				inBlock = false
				rest = rest.slice(end + 2)

				continue
			}

			const lineComment = rest.indexOf("//")
			const blockOpen = rest.indexOf("/*")

			if (blockOpen !== -1 && (lineComment === -1 || blockOpen < lineComment)) {
				code += rest.slice(0, blockOpen)
				rest = rest.slice(blockOpen + 2)
				inBlock = true

				continue
			}

			if (lineComment !== -1) {
				code += rest.slice(0, lineComment)

				break
			}

			code += rest

			break
		}

		if (code.trim() !== "") {
			count++
		}
	}

	return count
}

/**
 * Collected locations for each counter.
 */
export type DebtSites = Record<DebtCounterKind, string[]>

/**
 * Aggregated counters and sites for one repository walk.
 */
interface DebtLedger {
	counters: DebtCounters
	sites: DebtSites
	root: string
}

/**
 * Increment a counter and record its site.
 */
function note(ledger: DebtLedger, name: keyof DebtCounters, site: string): void {
	ledger.counters[name]++
	ledger.sites[name].push(site)
}

/**
 * Record one AST node occurrence at its start line.
 */
function noteNode(ledger: DebtLedger, name: keyof DebtCounters, source: ts.SourceFile, node: ts.Node): void {
	const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))

	note(ledger, name, `${relative(ledger.root, source.fileName)}:${line + 1}`)
}

function emptySites(): DebtSites {
	const initialCounters = createDebtRecord()
	const keys = Object.keys(initialCounters) as DebtCounterKind[]

	return Object.fromEntries(keys.map((name): [DebtCounterKind, string[]] => [name, []])) as DebtSites
}

function createDebtRecord(): DebtCounters {
	return {
		privateNameShadows: 0,
		exportNameAffix: 0,
		danglingDocLinks: 0,
		asNever: 0,
		doubleCast: 0,
		deepRelativeImports: 0,
		filterBoolean: 0,
		productionFilesOver1000Lines: 0,
		selfPackageImports: 0,
		synchronousFilesystemCalls: 0,
		rawNULBytes: 0,
		bannedVocabulary: 0,
		handRolledTreeWalks: 0,
	}
}

/**
 * Strip wrappers from a cast type (array/readonly/parenthesized).
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
 * Known synchronous filesystem call names.
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
 * True when a node is a direct synchronous filesystem call.
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

/**
 * Detect `stack.push(...node.children)` style tree-walk pushes.
 */
function isChildrenSpreadPush(node: ts.Node): boolean {
	return (
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.name.text === "push" &&
		node.arguments.some(
			(argument) =>
				ts.isSpreadElement(argument) &&
				ts.isPropertyAccessExpression(argument.expression) &&
				argument.expression.name.text === "children"
		)
	)
}

function visit(
	source: ts.SourceFile,
	ledger: DebtLedger,
	packageName: string | undefined,
	countSelfPackageImports: boolean
): void {
	function walk(node: ts.Node): void {
		if (isSynchronousFilesystemCall(node)) {
			noteNode(ledger, "synchronousFilesystemCalls", source, node)
		}

		if (isNeverCast(node)) {
			noteNode(ledger, "asNever", source, node)
		}

		if (ts.isAsExpression(node) && isUnknownCast(node.expression)) {
			noteNode(ledger, "doubleCast", source, node)
		}

		if (isChildrenSpreadPush(node)) {
			noteNode(ledger, "handRolledTreeWalks", source, node)
		}

		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			isDeepRelativeSpecifier(node.moduleSpecifier.text)
		) {
			noteNode(ledger, "deepRelativeImports", source, node)
		}

		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			countSelfPackageImports &&
			isSelfPackageSpecifier(node.moduleSpecifier.text, packageName)
		) {
			noteNode(ledger, "selfPackageImports", source, node)
		}

		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0]!) &&
			isDeepRelativeSpecifier(node.arguments[0]!.text)
		) {
			noteNode(ledger, "deepRelativeImports", source, node)
		}

		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0]!) &&
			countSelfPackageImports &&
			isSelfPackageSpecifier(node.arguments[0]!.text, packageName)
		) {
			noteNode(ledger, "selfPackageImports", source, node)
		}

		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "filter" &&
			node.arguments.length === 1 &&
			ts.isIdentifier(node.arguments[0]!) &&
			node.arguments[0]!.text === "Boolean"
		) {
			noteNode(ledger, "filterBoolean", source, node)
		}

		ts.forEachChild(node, walk)
	}

	walk(source)
}

/**
 * Tracked source prefixes excluded from debt counting.
 */
const UNCOUNTED = [
	// Runtime implementation files.
	"packages/core/lib/fs/",
	// This checker file itself.
	SELF,
]

/**
 * Regex for retired vocabulary matches.
 */
const BANNED_VOCABULARY =
	/(?<!\p{L})(?:[Ss]hard|SHARD)(?:s|ed|ing|S|ED|ING)?(?!\p{L})|(?<!\p{L})[A-Za-z_]*(?:[Ss]hard|SHARD)[A-Za-z_]*(?!\p{L})|(?<!\p{L})[A-Za-z_]*(?:[Ll]ever|LEVER)(?!age|AGE|ano|ANO|ton|TON|ock|OCK|stock|STOCK|dalsveien|DALSVEIEN|kusen|KUSEN|n\b|N\b)[A-Za-z_]*(?!\p{L})|(?<!\p{L})[A-Za-z_]*(?:[Ss]eam|SEAM)(?!er\b|ER\b|an\b|AN\b)[A-Za-z_]*(?!\p{L})|(?<!\p{L})(?:gat(?:e|es|ed|ing)|Gat(?:e|es|ed|ing)|GAT(?:E|ES|ED|ING))(?!\p{L})|(?<![\p{L}])[a-z][A-Za-z]*Gat(?:e|es|ed|ing)[A-Za-z]*(?!\p{L})|(?<!\p{L})[A-Za-z_]*_gat(?:e|es|ed|ing)_[A-Za-z_]*(?!\p{L})|(?<!\p{L})gat(?:e|es|ed|ing)_[A-Za-z_]*(?!\p{L})|(?<!\p{L})[A-Za-z_]*_gat(?:e|es|ed)(?!\p{L})|(?<!\p{L})[A-Z_]*GAT(?:E|ES|ED|ING)_[A-Z_]*(?!\p{L})|(?<!\p{L})[Cc]ut(?:s|ting)?(?!\p{L}|\s-[a-z])|(?<!\p{L})CUT(?:S|TING)?(?!\p{L})/gu

/**
 * Allowed path prefixes for retired-vocabulary matches, with reasons.
 */
const BANNED_VOCABULARY_ALLOWED: ReadonlyArray<readonly [prefix: string, reason: string]> = [
	[SELF, "the pattern above has to spell the words it bans"],
	["config/vale/styles/", "the Vale rules that REFUSE the word must name it"],
	[
		"packages/corpus/lib/tools/source-register/build.ts",
		"the substitution that keeps the word out of the address-source register must name what it replaces",
	],
	[
		"packages/repo-health/lib/checks/vocab-census.ts",
		"the ambiguous-shorthand census files a match under one of four words and must name each",
	],
	["packages/repo-health/test/unit/vocab-census.test.ts", "the census fixtures are lines of source quoted verbatim"],
	["config/vale/fixtures/", "Vale fixtures whose purpose is to keep failing, permanently"],
	[".claude/output-styles/", "the same refusal list, mirrored for agent replies"],
	["AGENTS.md", "carries that refusal list, plus the note recording that this family reached zero"],
	// Data and records may contain real names that must remain verbatim.
	["packages/core/data/", "libpostal dictionaries — real given names and surnames"],
	["data/", "address rows and reference tables carry real place names: Golden Gate Bridge, South Gate, Cut Bank"],
	[
		"packages/mailwoman/lib/eval-harness/gauntlet/cases/",
		"board rows are register data and carry real building names verbatim: Kew Gate, Singapore",
	],
	["evals/", "the score ledger's rows are dated notes on committed board cases"],
	["packages/corpus/data/", "the sub-venue lexicon: an airport gate is a real sub-venue token"],
	["packages/corpus/lib/recipes/sub/venue", "sub-venue recipes name the physical gate"],
	["packages/corpus/lib/tools/sub/venue", "sub-venue tooling names the physical gate"],
	["packages/corpus/test/unit/recipes/sub-venue", "sub-venue recipe tests name the physical gate"],
	["packages/corpus/test/unit/tools/sub-venue", "sub-venue tooling tests name the physical gate"],
	["packages/corpus/lib/tools/overture-subvenue.ts", "sub-venue extraction names the physical gate"],
	["packages/corpus/lib/tools/fetch/", "sub-venue source fetchers name the physical gate"],
	["packages/osm/lib/sdk/extract/subvenue/index.ts", "sub-venue extraction names the physical gate"],
	["packages/osm/lib/sdk/extract/subvenue/rules.ts", "the sub-venue tag rules name the physical gate"],
	["packages/osm/test/unit/sdk/extract/subvenue.test.ts", "sub-venue extraction tests name the physical gate"],
	["packages/neural/lib/venue-structure.ts", "venue structure names the physical gate"],
	["packages/neural/lib/span/proposal-prior.ts", "span proposals name the physical gate"],
	["packages/core/lib/pipeline/span-proposer.ts", "span proposals name the physical gate"],
	["packages/core/test/unit/pipeline/span-proposer.test.ts", "span proposal tests name the physical gate"],
	["packages/core/lib/decoder/containment.ts", "containment names the physical gate"],
	["packages/mailwoman/lib/geocode/result.ts", "the result shape names the physical gate"],
	["packages/mailwoman/lib/eval-harness/conformance/punctuation.ts", "punctuation conformance names the physical gate"],
	[
		"packages/mailwoman/test/unit/eval-harness/conformance/punctuation.test.ts",
		"punctuation conformance tests name the physical gate",
	],
	["packages/mailwoman/test/integration/venue-structure-confounds.test.ts", "venue confounds name the physical gate"],
	["packages/codex/lib/level-semantics.ts", "GATEPLAN is Norwegian for street level"],
	["packages/codex/test/unit/level-semantics.test.ts", "GATEPLAN is Norwegian for street level"],
	["packages/activity-lexicon/", "activity phrases name real-world actions"],
	["packages/poi-taxonomy/", "category names come from Overture verbatim"],
	["packages/geographic-model/", "world concepts name real-world things"],
	[".yarnrc.yml", "npmMinimalAgeGate is Yarn's own setting name"],
	["docs/static/sbom/", "an SBOM describes a published tarball; rewriting it fails verification"],
	["docs/static/img/", "binary images"],
	[
		"packages/mailwoman/lib/eval-harness/semantic-utility/",
		"a pre-registered probe definition is frozen by content hash; rewriting it breaks every receipt that cites the hash",
	],
	[
		"packages/mailwoman/lib/eval-harness/phase-2-decision/",
		"a pre-registered decision definition is frozen by content hash; rewriting it breaks every receipt that cites the hash",
	],
	["packages/neural/test/fixtures/", "a binary tokenizer model"],
	["data/gazetteer/", "gazetteer place names"],
	[".yarn/", "vendored third-party release"],
]

/**
 * Compute all debt counters.
 */
export async function computeDebtCounters(context: RepoContext): Promise<DebtCounters> {
	return (await computeDebtLedger(context)).counters
}

/**
 * Compute counters and record per-counter sites.
 */
async function computeDebtLedger(context: RepoContext): Promise<DebtLedger> {
	const root = context.repoRoot

	// Skip tracked files missing from the working tree.
	const paths = await trackedSourcePaths(context, { excludePrefixes: UNCOUNTED, existingOnly: true })

	const ledger: DebtLedger = { counters: createDebtRecord(), sites: emptySites(), root }

	const workspacePackages = await Promise.all(
		(await readWorkspaceDirectories(root)).map(async (workspace) => {
			const { name } = await readPackageJSON(resolvePath(root, workspace, "package.json"))

			return { directory: resolvePath(root, workspace), name }
		})
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

		// Tests may self-import by package name.
		const countSelfPackageImports = !path.includes("/test/") && !/[.]test[.]tsx?$/.test(path)

		visit(source, ledger, workspacePackage?.name, countSelfPackageImports)

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- File text already loaded.
		const nulBytes = text.split("\0").length - 1

		for (let i = 0; i < nulBytes; i++) {
			note(ledger, "rawNULBytes", relative(root, path))
		}

		const lineCount = codeLineCount(text)
		const generated = /(?:@generated|This file was generated by:)/.test(text.slice(0, 1000))

		if (!generated && !/[.]test[.]tsx?$/.test(path) && lineCount > PRODUCTION_FILE_LINE_CEILING) {
			note(ledger, "productionFilesOver1000Lines", `${relative(root, path)} (${lineCount} code lines)`)
		}
	}

	// Scan all tracked text files for retired vocabulary.
	for (const trackedPath of await trackedSourcePaths(context, { globs: ["*"], existingOnly: true })) {
		const relativePath = relative(root, trackedPath)

		if (BANNED_VOCABULARY_ALLOWED.some(([prefix]) => relativePath.startsWith(prefix))) continue

		let text: string

		try {
			text = await readLocalTextFile(trackedPath)
		} catch {
			continue
		}

		for (const match of text.matchAll(BANNED_VOCABULARY)) {
			const line = (text.slice(0, match.index).match(/\n/g)?.length ?? 0) + 1

			note(ledger, "bannedVocabulary", `${relativePath}:${line} — ${match[0]}`)
		}
	}

	for (const shadow of await findPrivateNameShadows(context)) {
		note(ledger, "privateNameShadows", `${shadow.file}:${shadow.line}`)
	}

	for (const pair of await findAffixPairs(context)) {
		note(ledger, "exportNameAffix", `${pair.file}:${pair.line}`)
	}

	for (const link of await findDanglingLinks(context)) {
		note(ledger, "danglingDocLinks", `${link.file}:${link.line}`)
	}

	return ledger
}

/**
 * Read committed baseline counters.
 */
export async function readBaseline(): Promise<DebtCounters> {
	return await readLocalJSONFile<DebtCounters>(BASELINE_PATH)
}

/**
 * Format counters with baseline values.
 */
export function formatCounters(counters: DebtCounters, baseline: DebtCounters): string[] {
	return Object.entries(counters).map(
		([name, count]) => `${name}: ${count} (baseline ${baseline[name as keyof DebtCounters]})`
	)
}

/**
 * Cap listed sites so one counter does not flood output.
 */
function listSites(sites: readonly string[]): string[] {
	if (sites.length <= SITE_CEILING) return [...sites]

	return [...sites.slice(0, SITE_CEILING), `… and ${sites.length - SITE_CEILING} more`]
}

/**
 * Max sites shown per counter.
 */
const SITE_CEILING = 40

/**
 * Debt check against baseline counters.
 */
export const debtCheck: RepoCheck = {
	id: "debt",
	description:
		"Monotonic debt counters against baseline.json: a counter that grew fails, one that fell asks for a ratchet.",
	async run(context) {
		const [ledger, baseline] = await Promise.all([computeDebtLedger(context), readBaseline()])
		const { counters, sites } = ledger
		const diagnostics: Diagnostic[] = []
		const file = relative(context.repoRoot, BASELINE_PATH)

		for (const [name, count] of Object.entries(counters) as Array<[keyof DebtCounters, number]>) {
			const recorded = baseline[name]

			if (typeof recorded !== "number") {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${name} is ${count} and has no baseline entry — record one with \`mwops health baseline debt\``,
					file,
					details: listSites(sites[name]),
				})
			} else if (count > recorded) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `Repository debt grew: ${name} ${recorded} → ${count}`,
					file,
					details: listSites(sites[name]),
				})
			} else if (count < recorded) {
				diagnostics.push({
					severity: DiagnosticSeverity.Warning,
					message: `${name} fell ${recorded} → ${count}; ratchet the baseline with \`mwops health baseline debt\``,
					file,
				})
			}
		}

		return diagnostics
	},
}
