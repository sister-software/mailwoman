/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Monotonic debt counters for patterns that are too contextual for a blanket lint error.
 *
 *   Existing debt is recorded in `baseline.json` beside this package; the `debt` check reports a counter that grew as an
 *   error and a counter that fell as a warning asking for the baseline to be ratcheted. WRITING the baseline is a
 *   mutation, so it is not a check: `mwops health baseline debt` calls {@link computeDebtCounters} through
 *   `lib/baseline.ts`, which the registry does not list. Never raise a counter to make a failure disappear.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { relative, resolvePath } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#check"
import { findPrivateNameShadows } from "#checks/private-name-shadows"
import { trackedSourcePaths } from "#tracked-sources"

export interface DebtCounters {
	/**
	 * Module-private functions in `packages/*\/lib` sharing a name with a function another module exports, minus the
	 * marked copies — the population `private-name-shadows-export` lists site by site. Ratchets down as copies are
	 * replaced by imports or given their reason.
	 */
	privateNameShadows: number
	asNever: number
	doubleCast: number
	deepRelativeImports: number
	filterBoolean: number
	/**
	 * Non-generated, non-test source files over 1,000 lines. Any file crossing 1,000 fails the check.
	 */
	productionFilesOver1000Lines: number
	selfPackageImports: number
	synchronousFilesystemCalls: number
	/**
	 * Raw NUL bytes in tracked TypeScript. A NUL makes grep classify the file as binary and skip it, so a guard that
	 * carries one is invisible to the sweeps that would read it; the escaped form (`\\0`, `\\x00`) is byte-identical at
	 * runtime and stays visible.
	 */
	rawNULBytes: number
	/**
	 * Occurrences of the retired vocabulary word — see {@link BANNED_VOCABULARY} for which — in any spelling, anywhere in
	 * tracked source: identifiers, comments and string literals alike.
	 *
	 * THIS SENTENCE DOES NOT NAME THE WORD, deliberately: a case-preserving sweep once rewrote the name to the
	 * REPLACEMENT and left the doc describing a different word than the pattern counts. One constant holds the term;
	 * prose points at the constant.
	 *
	 * The vocabulary is being removed because the word stood for FOUR different things (corpus recipes, per-country
	 * postcode databases, WOF extracts, and the providers' region databases), so there is no replacement synonym — each
	 * site takes the noun for the thing it actually names. The target is ZERO, and this counter is the finish line:
	 * ratcheted down per PR, it can only fall.
	 *
	 * COUNTED HERE RATHER THAN WITH `grep` ON PURPOSE. Tracked sources can carry raw NUL bytes, which `grep` treats as
	 * binary and skips SILENTLY — no error, no count. Measured: 3,481 occurrences with `grep -a` against 3,427 without,
	 * so a `grep`-based ratchet would hide 54 occurrences and could certify zero while they remained. `readLocalTextFile`
	 * has no such blind spot.
	 */
	bannedVocabulary: number
	/**
	 * `stack.push(...node.children)` — a hand-rolled LIFO tree walk. The idiom yields siblings in reverse text order, and
	 * a `find` over it picked the second of two same-tag spans (#2156, #2163); `walkNodes` in `@mailwoman/core/decoder`
	 * is the one walk, in document order. Baseline zero.
	 */
	handRolledTreeWalks: number
}

/**
 * The committed baseline the `debt` check compares against, beside this package's manifest.
 */
export const BASELINE_PATH = resolvePackagePath("@mailwoman/repo-health", "baseline.json")

/**
 * This module's own repo-relative path — excluded from the counts it takes, because the pattern below has to spell the
 * words it bans.
 */
const SELF = "packages/repo-health/lib/checks/debt.ts"

function emptyCounters(): DebtCounters {
	return {
		privateNameShadows: 0,
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
 * The baseline is ZERO. Workspaces that do not depend on `@mailwoman/core` — `api-kit`, `nuts-lookup`,
 * `timezone-lookup`, `un-locode-lookup`, `variant-aliases` — would install core's ~9 MB of data to replace a `mkdir` or
 * a `readFileSync`, and `oxlint.config.ts` exempts those files by name; they collapse the day the fs helpers can be
 * reached without core's tarball.
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

/**
 * `<stack>.push(...<expr>.children)` — the push half of a hand-rolled tree walk. The pop half is any `.pop()`, which
 * too many honest stacks share; the spread of `.children` is the tell.
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

		if (isChildrenSpreadPush(node)) {
			counters.handRolledTreeWalks++
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
	// THIS FILE COUNTS ITSELF OTHERWISE, and the count could never reach zero: {@link BANNED_VOCABULARY} has to
	// spell the word it bans. Excluded for the same reason as the line above — the implementation is not a caller.
	SELF,
]

/**
 * The words being removed from the codebase, and the pattern {@link DebtCounters.bannedVocabulary} counts. The third
 * alternation is the boundary word; it stops before the North Yorkshire town and the surname. The second alternation
 * carries a negative lookahead for the letter runs that continue it into an unrelated English word ("advantage") and
 * into six place names. It is case-sensitive on purpose: `availableVersions` and `localeVerdict` contain the letters
 * across a camelCase boundary that appear in eval rows and records; those survive verbatim by construction, not by
 * allowlist. The last alternation stops before a coreutils flag (` -c`, ` -d`): a shell command in a fenced block is
 * the utility, not the word.
 *
 * KEEP THE COUNTER'S NAME FREE OF THE WORD. This ratchet is written in the language it polices, so the vocabulary sweep
 * it exists to drive rewrote it: a case-preserving `shard` → `extract` pass over `scripts/` renamed `shardVocabulary`
 * to `extractVocabulary` AND rewrote this very pattern, so the check began measuring the REPLACEMENT word while still
 * reporting a falling number. It stayed green throughout. A neutral counter name and a single pattern constant are what
 * make that impossible to repeat.
 */
const BANNED_VOCABULARY =
	/(?<!\p{L})(?:[Ss]hard|SHARD)(?:s|ed|ing|S|ED|ING)?(?!\p{L})|(?<!\p{L})[A-Za-z_]*(?:[Ss]hard|SHARD)[A-Za-z_]*(?!\p{L})|(?<!\p{L})[A-Za-z_]*(?:[Ll]ever|LEVER)(?!age|AGE|ano|ANO|ton|TON|ock|OCK|stock|STOCK|dalsveien|DALSVEIEN|kusen|KUSEN|n\b|N\b)[A-Za-z_]*(?!\p{L})|(?<!\p{L})[A-Za-z_]*(?:[Ss]eam|SEAM)(?!er\b|ER\b|an\b|AN\b)[A-Za-z_]*(?!\p{L})|(?<!\p{L})(?:gat(?:e|es|ed|ing)|Gat(?:e|es|ed|ing)|GAT(?:E|ES|ED|ING))(?!\p{L})|(?<![\p{L}])[a-z][A-Za-z]*Gat(?:e|es|ed|ing)[A-Za-z]*(?!\p{L})|(?<!\p{L})[A-Za-z_]*_gat(?:e|es|ed|ing)_[A-Za-z_]*(?!\p{L})|(?<!\p{L})gat(?:e|es|ed|ing)_[A-Za-z_]*(?!\p{L})|(?<!\p{L})[A-Za-z_]*_gat(?:e|es|ed)(?!\p{L})|(?<!\p{L})[A-Z_]*GAT(?:E|ES|ED|ING)_[A-Z_]*(?!\p{L})|(?<!\p{L})[Cc]ut(?:s|ting)?(?!\p{L}|\s-[a-z])|(?<!\p{L})CUT(?:S|TING)?(?!\p{L})/gu

/**
 * Where the banned word is allowed to survive, and why each one earns it.
 *
 * THE COUNT IS OVER EVERY TRACKED TEXT FILE, not just `.ts`/`.tsx`. The first version of this counter scanned only
 * TypeScript, reported zero, and left 125 occurrences standing in prose, config, dictionaries and eval rows — including
 * three sentences in `AGENTS.md` that still told the next agent the old names were current. A vocabulary an agent reads
 * is a vocabulary an agent writes, so prose is in scope.
 */
const BANNED_VOCABULARY_ALLOWED: ReadonlyArray<readonly [prefix: string, reason: string]> = [
	[SELF, "the pattern above has to spell the words it bans"],
	["docs/styles/", "the Vale rules that REFUSE the word must name it"],
	[
		"packages/repo-health/lib/checks/vocab-census.ts",
		"the ambiguous-shorthand census files a match under one of four words and must name each",
	],
	["packages/repo-health/test/unit/vocab-census.test.ts", "the census fixtures are lines of source quoted verbatim"],
	["docs/scripts/vale-fixtures/", "Vale fixtures whose purpose is to keep failing, permanently"],
	[".claude/output-styles/", "the same refusal list, mirrored for agent replies"],
	["AGENTS.md", "carries that refusal list, plus the note recording that this family reached zero"],
	// RECORDS ARE NOT EXEMPT, and that is a deliberate reversal. They were exempt on the reasoning that
	// rewriting a record falsifies it — but a record names PATHS and IDENTIFIERS, not measurements, and a
	// retired name in a record is read as a live one by the next agent. Every number, date and verdict is
	// untouched; only the spelling of things that were renamed moved with them. Operator direction, and the
	// reason given was the operative one: agents pick the vocabulary back up from prose.
	// CONTENT, not vocabulary. `shardza`, `sechshard` and `shykshard` are transliterated place names;
	// `Bosshardt` and `Rashard` are real people's names; the eval rows are dated notes on committed board
	// cases. Renaming any of them would corrupt data to satisfy a style rule.
	["packages/core/data/", "libpostal dictionaries — real given names and surnames"],
	["data/", "address rows and reference tables carry real place names: Golden Gate Bridge, South Gate, Cut Bank"],
	["evals/", "the score ledger's rows are dated notes on committed board cases"],
	["packages/corpus/data/", "the sub-venue lexicon: an airport gate is a real sub-venue token"],
	["packages/corpus/lib/recipes/sub-venue", "sub-venue recipes name the physical gate"],
	["packages/corpus/lib/tools/sub-venue", "sub-venue tooling names the physical gate"],
	["packages/corpus/test/unit/recipes/sub-venue", "sub-venue recipe tests name the physical gate"],
	["packages/corpus/test/unit/tools/sub-venue", "sub-venue tooling tests name the physical gate"],
	["packages/corpus/lib/tools/overture-subvenue.ts", "sub-venue extraction names the physical gate"],
	["packages/corpus/lib/tools/fetch/", "sub-venue source fetchers name the physical gate"],
	["packages/osm/lib/sdk/extract-subvenue.ts", "sub-venue extraction names the physical gate"],
	["packages/osm/test/unit/sdk/extract-subvenue.test.ts", "sub-venue extraction tests name the physical gate"],
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
 * Count every debt counter over the tracked tree of `context`.
 */
export async function computeDebtCounters(context: RepoContext): Promise<DebtCounters> {
	const root = context.repoRoot

	// `existingOnly`: a tracked path can be absent from the working tree (a deletion staged but not
	// committed); skip it rather than failing the whole check on a file the next commit removes anyway.
	const paths = await trackedSourcePaths(context, { excludePrefixes: UNCOUNTED, existingOnly: true })

	const counters = emptyCounters()

	const workspacePackages = await Promise.all(
		(await readWorkspaceDirectories(root)).map(async (workspace) => ({
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

		counters.rawNULBytes += text.split("\0").length - 1

		const lineCount = (text.match(/\n/g)?.length ?? 0) + 1
		const generated = /(?:@generated|This file was generated by:)/.test(text.slice(0, 1000))

		if (!generated && !/[.]test[.]tsx?$/.test(path) && lineCount > 1000) {
			counters.productionFilesOver1000Lines++
		}
	}

	// The banned vocabulary is counted over EVERY tracked text file rather than the TypeScript-only set above:
	// prose an agent reads is prose an agent copies. Binary blobs are skipped by the read failing, not by a list.
	for (const trackedPath of await trackedSourcePaths(context, { globs: ["*"], existingOnly: true })) {
		const relativePath = relative(root, trackedPath)

		if (BANNED_VOCABULARY_ALLOWED.some(([prefix]) => relativePath.startsWith(prefix))) continue

		let text: string

		try {
			text = await readLocalTextFile(trackedPath)
		} catch {
			continue
		}

		counters.bannedVocabulary += text.match(BANNED_VOCABULARY)?.length ?? 0
	}

	counters.privateNameShadows = (await findPrivateNameShadows(context)).length

	return counters
}

/**
 * The committed counters.
 */
export async function readBaseline(): Promise<DebtCounters> {
	return await readLocalJSONFile<DebtCounters>(BASELINE_PATH)
}

/**
 * One line per counter, each with its baseline, for a human reading the readings.
 */
export function formatCounters(counters: DebtCounters, baseline: DebtCounters): string[] {
	return Object.entries(counters).map(
		([name, count]) => `${name}: ${count} (baseline ${baseline[name as keyof DebtCounters]})`
	)
}

/**
 * The `debt` check: an error per counter above its baseline, a warning per counter below it.
 */
export const debtCheck: RepoCheck = {
	id: "debt",
	description:
		"Monotonic debt counters against baseline.json: a counter that grew fails, one that fell asks for a ratchet.",
	async run(context) {
		const [counters, baseline] = await Promise.all([computeDebtCounters(context), readBaseline()])
		const diagnostics: Diagnostic[] = []
		const file = relative(context.repoRoot, BASELINE_PATH)

		for (const [name, count] of Object.entries(counters) as Array<[keyof DebtCounters, number]>) {
			const recorded = baseline[name]

			if (typeof recorded !== "number") {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${name} is ${count} and has no baseline entry — record one with \`mwops health baseline debt\``,
					file,
				})
			} else if (count > recorded) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `Repository debt grew: ${name} ${recorded} → ${count}`,
					file,
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
