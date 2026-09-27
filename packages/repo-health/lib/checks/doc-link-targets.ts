/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A `{@link}` or `{@linkcode}` naming a symbol with no declaration. The tag reads as a promise that the thing
 *   exists, and an agent following one implements the name instead of finding the code: `readPackageJSONFile` was
 *   never a declaration anywhere in this repository, only a `@see {@linkcode …}` target, and it was written twice
 *   before anyone noticed there was no declaration to find.
 *
 *   what IT checks. A bare identifier target — `{@link foo}`, `{@linkcode Foo.bar}` — against the set of names
 *   the tree declares or imports anywhere. A URL target, a path, and a `{@link foo | text}` label are all left alone.
 *   The name set is repository-wide rather than per-file on purpose: a link to a name declared in another package is
 *   correct and common, so a per-file rule would report thousands of them.
 *
 *   A backticked name inside a doc comment is read the same way when it is shaped like a declaration: a call such
 *   as `` `parse()` ``, or a camel-case name with at least two humps such as `` `readPackageJSONFile` ``. A short
 *   backticked word (`` `db` ``, `` `lat` ``, a CLI flag, a wire field) is prose and is not judged. A backticked name
 *   the tree never declares carries the same false promise as a link tag, and is reported the same way.
 *
 *   that width is the limit, and it is stated rather than hidden: a tag naming a symbol that exists somewhere but not
 *   where the reader can reach it still passes. What this refuses is the name that exists nowhere at all, which is the
 *   case that sends someone off to write it.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { relative } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

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
 * A capital that opens a new camel-case component: one after a lowercase letter or digit,
 * or one that closes a run of capitals before a lowercase letter.
 * `readPackageJSONFile` has three, `GeoCoordinate` one.
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
 * Whether a backticked name is shaped like a declaration: a camel-case name with at
 * least {@linkcode HUMP_FLOOR} humps, or a call with at least one.
 *
 * A single word, called or not, is prose, and prose may spell anything:
 * `` `float()` `` is Python's and `` `hsl()` `` is CSS's.
 *
 * A dotted name is judged by its head, since the head is what resolves:
 * `` `str.isupper()` `` is a call on a word.
 * A name with no lowercase letter is a code such as a postcode.
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
 * Line comments and plain block comments are left out: a doc comment describes a declaration,
 * and a name it backticks is read as a promise about the code.
 */
function docComments(text: string, file: string): Array<{ pos: number; text: string }> {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
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
 * Every `{@link}` target and every declaration-shaped backticked name in the file, in document order.
 */
function docTargets(text: string, file: string): DocTarget[] {
	const targets: DocTarget[] = []

	for (const match of text.matchAll(LINK_TAG)) {
		const target = match.groups?.["target"] ?? ""

		if (isJudgeable(target)) {
			targets.push({ offset: match.index, target })
		}
	}

	for (const comment of docComments(text, file)) {
		for (const match of comment.text.matchAll(BACKTICKED_NAME)) {
			const target = match.groups?.["target"] ?? ""

			if (!isDeclarationShaped(target)) continue

			targets.push({ offset: comment.pos + match.index, target: target.replace(/\(\)$/u, "") })
		}
	}

	return targets.toSorted((a, b) => a.offset - b.offset)
}

/**
 * Every identifier the file spells, in a declaration or a use.
 *
 * A name the code reaches on an external library (`toLowerCase`, `readFileSync`) is as
 * real as one the tree declares, and a doc comment may point at either.
 * This is the vocabulary a link in this repository may name.
 */
function spelledNames(text: string, file: string, into: Set<string>): void {
	const source = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		false,
		file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	)

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
 * This module's own repo-relative path, excluded from the sweep it performs: the header has to spell
 * the tag shapes it looks for, and `{@link foo}` in an explanation is an example rather than a promise.
 *
 * `debt.ts` excludes itself from its own vocabulary count for the same reason.
 */
const SELF = "packages/repo-health/lib/checks/doc-link-targets.ts"

/**
 * Declaration-shaped identifiers of another project that a doc comment may spell:
 * a library's export, a service's wire field, a compiler option.
 *
 * Each entry states its owner, so a reader can tell it from a stale name of this repository.
 * The register is keyed by the head of a dotted name.
 *
 * An entry no judged doc comment spells any more is reported, so the register
 * cannot outlive the prose it admits.
 */
export const EXTERNAL_DOC_NAMES: Readonly<Record<string, string>> = {
	InferTupleMember: "@isp.nexus/core",
	ServiceExceptionReport: "the OGC service exception report element",
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
}

interface DocLinkSweep {
	dangling: DanglingLink[]
	/**
	 * Register entries that no judged doc comment spells.
	 */
	staleExternals: string[]
}

/**
 * Every doc target the tree never declares, and every register entry the tree no longer needs.
 */
async function sweepDocLinks(context: RepoContext): Promise<DocLinkSweep> {
	// The vocabulary is read from every tracked TypeScript file, tests and docs included,
	// since a name a test spells is one the tree knows.
	// Only a doc comment under packages/*/lib is judged against it.
	const paths = await trackedSourcePaths(context, { existingOnly: true })
	const judged = /^packages\/[^/]+\/lib\/.*\.ts$/u

	const texts = new Map<string, string>()
	const known = new Set<string>()

	for (const path of paths) {
		const file = relative(context.repoRoot, path)
		const text = await readLocalTextFile(path)

		if (judged.test(file)) {
			texts.set(file, text)
		}

		spelledNames(text, file, known)
	}

	const dangling: DanglingLink[] = []
	const admitted = new Set<string>()

	for (const [file, text] of texts) {
		if (file === SELF) continue

		for (const { offset, target } of docTargets(text, file)) {
			// A dotted target is satisfied by its head: `Foo.bar` is reachable when `Foo` is.
			const head = target.split(".")[0]!

			// Read before the vocabulary: the register's own keys are identifiers this file spells.
			if (Object.hasOwn(EXTERNAL_DOC_NAMES, head)) {
				admitted.add(head)

				continue
			}

			if (known.has(head) || isKeyword(head)) continue

			// A language built-in is a legitimate target and belongs to no file.
			// Asked of the runtime rather than kept as a list, which would go stale against the platform.
			if (head in globalThis) continue

			// oxlint-disable-next-line mailwoman/prefer-spliterator -- counting newlines in a string already resident.
			const line = text.slice(0, offset).split("\n").length

			dangling.push({ file, line, target })
		}
	}

	// The register lives in this file.
	// A tree without it, such as a planted test tree, has no entry to judge.
	const staleExternals = texts.has(SELF) ? Object.keys(EXTERNAL_DOC_NAMES).filter((name) => !admitted.has(name)) : []

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
 * The check: each dangling link as a warning, because a tag promising a symbol that
 * does not exist is how a name gets implemented instead of imported.
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
			})
		}

		for (const name of staleExternals) {
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				file: SELF,
				message: `\`${name}\` is registered in EXTERNAL_DOC_NAMES and no doc comment spells it. Remove the entry.`,
			})
		}

		return diagnostics
	},
}
