/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file This check finds `{@link}` or `{@linkcode}` tags that point to undeclared symbols.
 *   Readers can follow a tag as a promise that the symbol exists.
 *
 *   A bare identifier target such as `{@link foo}` or `{@linkcode Foo.bar}` is checked against every identifier
 *   the tree declares or imports. URL targets and file paths are handled as addresses. A `{@link foo | text}`
 *   label supplies its own display text. The identifier set covers the repository because links may point across packages.
 *
 *   A backticked token inside a doc comment is checked when it has declaration shape. Examples include
 *   `` `parse()` `` and camel-case `` `readPackageJSONFile` ``. Short tokens such as `` `db` `` and `` `lat` ``
 *   remain prose. The same applies to CLI flags and wire fields.
 *
 *   A tag naming a symbol that exists somewhere but not where the reader can reach it still passes. What this refuses
 *   is the name that exists nowhere at all.
 */

import { relative } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#repo-health/check"
import { parseContextSource, readContextSources } from "#repo-health/context"
import { PACKAGE_SOURCE_PATH, trackedSourcePaths } from "#repo-health/tracked-sources"

/**
 * A link tag and its target, up to the first separator: `{@link foo}`, `{@linkcode Foo.bar | text}`.
 */
const LINK_TAG = /\{@link(?:code|plain)?\s+(?<target>[^}\s|]+)/gu

/**
 * A backticked span holding one dotted identifier, optionally called: `` `foo` ``,
 * `` `Foo.bar` ``, `` `parse()` ``.
 */
const BACKTICKED_NAME = /`(?<target>[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?)`/gu

/**
 * A capital that opens a new camel-case component: one after a lowercase letter
 * or digit, or one closing a run of capitals before a lowercase letter.
 */
const HUMP = /(?<=[a-z0-9])[A-Z]|(?<=[A-Z])[A-Z](?=[a-z])/gu

/**
 * The fewest humps a backticked name needs before it reads as a declaration rather than a word.
 */
const HUMP_FLOOR = 2

/**
 * A target this cannot judge: a URL, a path, a file, or anything that is not a plain dotted identifier.
 */
function isJudgeable(target: string): boolean {
	if (/^(?:https?:|\.|\/|#)/u.test(target)) return false

	return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(target)
}

/**
 * A dotted tail that is a file extension rather than a member: `` `admin1CodesASCII.txt` `` is a file.
 */
const FILE_EXTENSION_TAIL = /\.[a-z0-9]{1,4}$/u

/**
 * Whether a backticked name is shaped like a declaration: a camel-case name
 * with at least {@linkcode HUMP_FLOOR} humps, or a call with at least one,
 * judged by its head since the head is what resolves.
 *
 * Single-word tokens remain prose with or without call syntax.
 * A token without a lowercase letter is a code, such as a postcode.
 */
function isDeclarationShaped(target: string): boolean {
	if (FILE_EXTENSION_TAIL.test(target)) return false

	const head = target.split(".")[0]!

	if (!/[a-z]/u.test(head)) return false

	const humps = (head.match(HUMP) ?? []).length
	const floor = target.endsWith("()") && !target.includes(".") ? 1 : HUMP_FLOOR

	return humps >= floor
}

/**
 * Every doc comment in the file, as its text.
 *
 * Line and plain block comments are left out because only a doc comment's
 * backticked names read as promises about the code.
 */
function docComments(source: ts.SourceFile): Array<{ pos: number; text: string }> {
	const { text } = source
	const seen = new Set<number>()
	const comments: Array<{ pos: number; text: string }> = []

	const visit = (node: ts.Node): void => {
		for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
			if (seen.has(range.pos)) continue

			seen.add(range.pos)

			if (range.kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue

			const comment = text.slice(range.pos, range.end)

			if (comment.startsWith("/**")) {
				comments.push({ pos: range.pos, text: comment })
			}
		}

		ts.forEachChild(node, visit)
	}

	visit(source)

	return comments
}

/**
 * A name that a doc comment may point at, with the offset it sits at in the file.
 */
interface DocTarget {
	offset: number
	target: string
}

/**
 * Every `{@link}` target and declaration-shaped backticked name in the file's doc comments.
 *
 * Targets come back in document order.
 * A string literal that spells a doc comment is skipped, such as a test's planted source file.
 */
function docTargets(source: ts.SourceFile): DocTarget[] {
	const targets: DocTarget[] = []

	for (const comment of docComments(source)) {
		for (const match of comment.text.matchAll(LINK_TAG)) {
			const target = match.groups?.["target"] ?? ""

			if (isJudgeable(target)) {
				targets.push({ offset: comment.pos + match.index, target })
			}
		}

		for (const match of comment.text.matchAll(BACKTICKED_NAME)) {
			const target = match.groups?.["target"] ?? ""

			if (!isDeclarationShaped(target)) continue

			targets.push({ offset: comment.pos + match.index, target: target.replace(/\(\)$/u, "") })
		}
	}

	return targets.toSorted((a, b) => a.offset - b.offset)
}

/**
 * Every identifier the file spells in a declaration or use, including external-library identifiers.
 *
 * A doc comment may point to an external identifier or a local declaration.
 */
function spelledNames(source: ts.SourceFile, into: Set<string>): void {
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
			into.add(node.text)
		}

		ts.forEachChild(node, visit)
	}

	visit(source)
}

/**
 * A reserved word reads as a call in prose (`` `import()` ``, `` `with()` ``) and is no declaration.
 */
function isKeyword(name: string): boolean {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, name)

	const kind = scanner.scan()

	return (
		kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword && scanner.getTokenEnd() === name.length
	)
}

export interface DanglingLink {
	file: string
	line: number
	target: string
}

/**
 * This module's own repo-relative path, excluded from the sweep it performs because the
 * header spells the tag shapes it looks for and an example there is not a promise.
 */
const SELF = "lib/repo-health/checks/doc-link-targets.ts"

/**
 * Declaration-shaped identifiers of another project that a doc comment may spell —
 * a library's export, a service's wire field, a compiler option — keyed by the
 * head of a dotted name, each entry stating its owner.
 *
 * An entry no judged doc comment spells is reported, so the register cannot outlive the prose it admits.
 */
const EXTERNAL_DOC_NAMES: Readonly<Record<string, string>> = {
	InferTupleMember: "@isp.nexus/core",
	ServiceExceptionReport: "the OGC service exception report element",
	addressNumber2ndExtension: "the INSPIRE LocatorDesignatorTypeValue codelist",
	addressNumberExtension: "the INSPIRE LocatorDesignatorTypeValue codelist",
	addressIdentifierGeneral: "the INSPIRE LocatorDesignatorTypeValue codelist",
	buildingIdentifierPrefix: "the INSPIRE LocatorDesignatorTypeValue codelist",
	postalDeliveryIdentifier: "the INSPIRE LocatorDesignatorTypeValue codelist",
	postalDeliveryPoint: "the INSPIRE LocatorLevelValue codelist",
	PagingIsTransactionSafe: "an OGC filter-capabilities conformance flag",
	GetFeatureById: "the WFS stored query",
	fileDataSetId: "the Environment Agency file service's wire field",
	selectAttrbDBDwldList: "the juso.go.kr portal endpoint",
	ODbL: "the SPDX license identifier",
	erasableSyntaxOnly: "a TypeScript compiler option",
	PostalAddressPart: "the Census geocoder API",
	getShortName: "the Google geocoder helper this parser was ported from",
	getLongName: "the Google geocoder helper this parser was ported from",
	ListObjectsV2: "the S3 API",
	SentencePieceText: "the SentencePiece protobuf message",
	getEditsForFileRename: "the TypeScript language service",
	readFileSync: "node:fs",
	WhosOnFirstClassifier: "the Pelias parser's dictionary classifier",
	DynamicQuantizeLinear: "the ONNX operator",
	ImplementsResultPaging: "the WFS 2.0 capabilities constraint",
}

interface DocLinkSweep {
	dangling: DanglingLink[]
	/**
	 * Register entries that no judged doc comment spells.
	 */
	staleExternals: string[]
}

/**
 * Every doc target the tree does not declare and every register entry the tree no longer needs.
 */
async function sweepDocLinks(context: RepoContext): Promise<DocLinkSweep> {
	// The vocabulary is read from every tracked TypeScript file, tests included,
	// while only a doc comment under a package's source roots is judged against it.
	const paths = await trackedSourcePaths(context, { existingOnly: true })
	const judged = { test: (path: string) => PACKAGE_SOURCE_PATH.test(path) && path.endsWith(".ts") }

	// A judged path ends in `.ts`, so its doc comments are read from the same tree its names are.
	const sources = new Map<string, ts.SourceFile>()
	const known = new Set<string>()

	await readContextSources(context, paths)

	for (const path of paths) {
		const file = relative(context.repoRoot, path)
		const source = await parseContextSource(context, path)

		if (judged.test(file)) {
			sources.set(file, source)
		}

		spelledNames(source, known)
	}

	const dangling: DanglingLink[] = []
	const admitted = new Set<string>()

	for (const [file, source] of sources) {
		if (file === SELF) continue

		const { text } = source

		for (const { offset, target } of docTargets(source)) {
			// A dotted target is satisfied by its head: `Foo.bar` is reachable when `Foo` is.
			const head = target.split(".")[0]!

			// Read before the vocabulary: the register's own keys are identifiers this file spells.
			if (Object.hasOwn(EXTERNAL_DOC_NAMES, head)) {
				admitted.add(head)

				continue
			}

			if (known.has(head) || isKeyword(head)) continue

			// A language built-in is a legitimate target and belongs to no file,
			// asked of the runtime rather than kept as a list that would go stale.
			if (head in globalThis) continue

			// oxlint-disable-next-line mailwoman/prefer-spliterator -- counting newlines in a string already resident.
			const line = text.slice(0, offset).split("\n").length

			dangling.push({ file, line, target })
		}
	}

	// The register lives in this file, so a tree without it — a planted test tree — has no entry to judge.
	const staleExternals = sources.has(SELF) ? Object.keys(EXTERNAL_DOC_NAMES).filter((name) => !admitted.has(name)) : []

	return {
		dangling: dangling.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
		staleExternals,
	}
}

/**
 * Every link tag or declaration-shaped backticked name whose head is absent from the tree's vocabulary.
 */
export async function findDanglingLinks(context: RepoContext): Promise<DanglingLink[]> {
	return (await sweepDocLinks(context)).dangling
}

/**
 * Each dangling link as a warning, because a tag promising a symbol that does not
 * exist is how a name gets implemented instead of imported.
 */
export const docLinkTargetsCheck: RepoCheck = {
	id: "doc-link-targets",
	description:
		"A {@link}, {@linkcode}, or declaration-shaped backticked name in a packages/*/lib doc comment that nothing in the tree declares. The tag reads as a promise the thing exists.",
	async run(context) {
		const diagnostics: Diagnostic[] = []
		const { dangling, staleExternals } = await sweepDocLinks(context)

		for (const link of dangling) {
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				file: link.file,
				line: link.line,
				message: `\`${link.target}\` is linked or backticked here and nothing this repository declares it. Point it at the symbol that exists, or write the name in plain text.`,
				details: null,
			})
		}

		for (const name of staleExternals) {
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				file: SELF,
				message: `\`${name}\` is registered in EXTERNAL_DOC_NAMES and no doc comment spells it. Remove the entry.`,
				line: null,
				details: null,
			})
		}

		return diagnostics
	},
}
