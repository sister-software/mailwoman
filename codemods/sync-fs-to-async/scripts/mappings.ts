/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Which `@mailwoman/core/fs` helper each `node:fs` builtin becomes, and under what shape.
 *
 *   Split from `./codemod.ts` because it is one concern and a long one: the table plus the argument readers that decide
 *   between two helpers is more than half the transform's lines, and none of it is about traversal.
 *
 *   Every mapping is equal to the builtin or a strict SUPERSET of it. The supersets are the ceremonies the helpers
 *   exist for — the file writers create the parent directory, `copyFileTo` and `createSymbolicLink` clear the
 *   destination — and each succeeds where the builtin threw and fails nowhere it succeeded.
 *
 *   Throwing and forgiving are never conflated, because that is the distinction a rename can silently destroy.
 */

import type { SgNode } from "codemod:ast-grep"
import type TSX from "codemod:ast-grep/langs/tsx"
import type TS from "codemod:ast-grep/langs/typescript"

export type Lang = TS | TSX

/**
 * The four `@mailwoman/core/fs` modules a plan can name, spelled as the subpath they are imported by.
 *
 * The pair split is by BLOCKING, not by concern: `readers`/`writers` answer promises and are what a call site should
 * reach for; `readers-sync`/`writers-sync` carry the same contracts for a slot whose caller is synchronous and not ours
 * to change.
 */
export const READERS = "readers"

/**
 * @see {@linkcode READERS}
 */
export const WRITERS = "writers"

/**
 * @see {@linkcode READERS}
 */
export const READERS_SYNC = "readers-sync"

/**
 * @see {@linkcode READERS}
 */
export const WRITERS_SYNC = "writers-sync"

export interface Plan {
	helper: string
	/**
	 * The type argument to carry across, spelled with its angle brackets.
	 *
	 * `parseJSONStrict<Manifest>(…)` states what the file holds, and `readLocalJSONFile` defaults to `Record<string,
	 * unknown>` without it. Dropping it turned 101 typed reads into untyped ones and the compiler reported the loss 254
	 * times, several frames downstream of the rewrite.
	 */
	typeArguments?: string
	module: typeof READERS | typeof WRITERS | typeof READERS_SYNC | typeof WRITERS_SYNC
	args: string[]
	/**
	 * The node the rewrite replaces, when it is wider than the filesystem call itself — `parseJSONStrict(readFileSync(p,
	 * "utf8"))` collapses to one `readLocalJSONFile(p)`, so the whole wrapper goes.
	 */
	replaces?: SgNode<Lang>
}

/**
 * The named children of a call's argument list, punctuation excluded.
 */
export function callArguments(call: SgNode<Lang>): SgNode<Lang>[] {
	const list = call.field("arguments")

	if (!list) return []

	// A COMMENT is a named node, so `import(/* webpackIgnore: true */ "…")` reports the comment as argument zero. That
	// hid eight `fs.readFileSync` calls in `packages/neural/classifier.ts`, whose module alias is bound from exactly
	// that shape — and anywhere else it would have handed a mapping the comment's text where a path belongs.
	return list.children().filter((child) => child.isNamed() && child.kind() !== "comment")
}

/**
 * Whether a node is an object literal carrying exactly the given properties, each set to `true`.
 */
export function optionsAre(node: SgNode<Lang> | undefined, ...expected: string[]): boolean {
	if (!node) return expected.length === 0

	if (node.kind() !== "object") return false

	const pairs = node.children().filter((child) => child.kind() === "pair")

	if (pairs.length !== expected.length) return false

	return pairs.every((pair) => {
		const key = pair.field("key")?.text()
		const value = pair.field("value")?.text()

		return key !== undefined && expected.includes(key) && value === "true"
	})
}

/**
 * Whether a node is a `utf8` encoding argument, in either the bare-string or the options-object spelling.
 */
export function isUTF8(node: SgNode<Lang> | undefined): boolean {
	if (!node) return false

	const text = node.text()

	if (/^["'`]utf-?8["'`]$/i.test(text)) return true

	return node.kind() === "object" && /^\{\s*encoding:\s*["'`]utf-?8["'`]\s*,?\s*\}$/i.test(text)
}

/**
 * Whether an expression is syntactically certain to be a string.
 *
 * Syntactic rather than type-directed: JSSG's semantic analysis answers within one file, and the value written here is
 * routinely produced somewhere else. When neither this nor {@linkcode isCertainlyBytes} is sure, the rewrite uses
 * `writeLocalFile`, which accepts both — a wrong-but-plausible narrowing is the outcome worth avoiding.
 */
export function isCertainlyText(node: SgNode<Lang>): boolean {
	const kind = node.kind()

	if (kind === "string" || kind === "template_string") return true

	const text = node.text()

	if (text.startsWith("JSON.stringify(")) return true

	if (text.startsWith("String(")) return true

	if (/\.join\(/.test(text) && !/Buffer/.test(text)) return true

	if (kind === "binary_expression" && node.field("operator")?.text() === "+") {
		const left = node.field("left")

		return left ? isCertainlyText(left) : false
	}

	return false
}

/**
 * Whether an expression is syntactically certain to be bytes.
 */
export function isCertainlyBytes(node: SgNode<Lang>): boolean {
	return /^(Buffer\.(from|alloc|concat)|new (Uint8Array|Buffer))\(/.test(node.text())
}

/**
 * The value a `JSON.stringify(…)` call serializes, when the call is a plain serialization this codemod can move to
 * {@linkcode writeLocalJSONFile}.
 *
 * A REPLACER — the second argument, when it is anything but `null` or `undefined` — chooses which keys survive, so the
 * output is not the value and the swap would silently change what is written.
 */
export function jsonStringifyValue(node: SgNode<Lang>): string | undefined {
	if (node.kind() !== "call_expression") return undefined

	if (node.field("function")?.text() !== "JSON.stringify") return undefined

	const args = callArguments(node)

	if (!args.length) return undefined

	const replacer = args[1]?.text()

	if (replacer !== undefined && replacer !== "null" && replacer !== "undefined") return undefined

	return args[0]!.text()
}

/**
 * Wrappers that parse a file's text as JSON, so `WRAPPER(readFileSync(p, "utf8"))` is a JSON READ spelled out.
 *
 * `tryParsingJSON` is deliberately absent: it answers `null` where these throw, and `readLocalJSONFile` throws.
 * `JSON.parse` is present, and it is the one inexact mapping here — `parseJSONStrict` raises `JSONParseError` where the
 * builtin raises `SyntaxError`, so a `catch` that tests the class sees a different one.
 */
export const JSON_PARSE_WRAPPERS = new Set(["JSON.parse", "parseJSONStrict"])

/**
 * The `WRAPPER(…)` call this filesystem read is the sole argument of, when that wrapper parses JSON.
 */
export function jsonParseWrapper(call: SgNode<Lang>): SgNode<Lang> | undefined {
	const list = call.parent()

	if (list?.kind() !== "arguments") return undefined

	const outer = list.parent()

	if (outer?.kind() !== "call_expression") return undefined

	if (!JSON_PARSE_WRAPPERS.has(outer.field("function")?.text() ?? "")) return undefined

	// The sole argument. `JSON.parse(text, reviver)` transforms what it parses, and no reader here does that.
	return callArguments(outer).length === 1 ? outer : undefined
}

export type Mapping = (call: SgNode<Lang>, args: SgNode<Lang>[]) => Plan | null

/**
 * The asynchronous builtins, mapped to the same helpers by the same rules as their synchronous twins.
 *
 * `open` is absent: a `FileHandle` is owned, and moving ownership is not a rename.
 */
export const PROMISE_MAPPINGS: Record<string, Mapping> = {
	readFile: (call, args) => MAPPINGS.readFileSync!(call, args),
	writeFile: (call, args) => MAPPINGS.writeFileSync!(call, args),
	appendFile: (call, args) => MAPPINGS.appendFileSync!(call, args),
	mkdir: (call, args) => MAPPINGS.mkdirSync!(call, args),
	rm: (call, args) => MAPPINGS.rmSync!(call, args),
	unlink: (call, args) => MAPPINGS.unlinkSync!(call, args),
	readdir: (call, args) => MAPPINGS.readdirSync!(call, args),
	stat: (call, args) => MAPPINGS.statSync!(call, args),
	lstat: (call, args) => MAPPINGS.lstatSync!(call, args),
	realpath: (call, args) => MAPPINGS.realpathSync!(call, args),
	rename: (call, args) => MAPPINGS.renameSync!(call, args),
	copyFile: (call, args) => MAPPINGS.copyFileSync!(call, args),
	cp: (call, args) => MAPPINGS.cpSync!(call, args),
	symlink: (call, args) => MAPPINGS.symlinkSync!(call, args),
	chmod: (call, args) => MAPPINGS.chmodSync!(call, args),
	utimes: (call, args) => MAPPINGS.utimesSync!(call, args),
}

/**
 * Each synchronous `node:fs` builtin, mapped to the helper that replaces it under the shape the call actually has.
 *
 * A name absent here has no equal helper and is left alone: `accessSync` asks a permission question two helpers split
 * between them, `globSync` answers unsorted, and the descriptor calls own a handle.
 */
export const MAPPINGS: Record<string, Mapping> = {
	existsSync: (_call, args) =>
		args.length === 1 ? { helper: "pathExists", module: READERS, args: [args[0]!.text()] } : null,

	readFileSync: (call, args) => {
		// `readFileSync(0, "utf8")` reads STDIN: the first argument is a file DESCRIPTOR, and no path helper accepts one.
		// Only the literal form is visible here — a descriptor behind a name (`readFileSync(STDIN, …)`) reads exactly
		// like a path, and typecheck is what catches it.
		if (args[0]?.kind() === "number") return null

		if (args.length === 1) return { helper: "readLocalBuffer", module: READERS, args: [args[0]!.text()] }

		if (args.length !== 2 || !isUTF8(args[1])) return null

		const wrapper = jsonParseWrapper(call)

		if (wrapper) {
			return {
				helper: "readLocalJSONFile",
				module: READERS,
				args: [args[0]!.text()],
				replaces: wrapper,
				typeArguments: wrapper.field("type_arguments")?.text(),
			}
		}

		return { helper: "readLocalTextFile", module: READERS, args: [args[0]!.text()] }
	},

	writeFileSync: (_call, args) => {
		if (args.length < 2 || args.length > 3) return null

		if (args.length === 3 && !isUTF8(args[2])) return null

		const [path, content] = args as [SgNode<Lang>, SgNode<Lang>]

		// `writeFileSync(p, JSON.stringify(x))` is a JSON write spelled out. `writeLocalJSONFile` is the same write with
		// the house formatting — tab-indented, one trailing newline — so the BYTES change even though the value does not.
		// A serializer with a replacer function is not that, and stays text.
		const serialized = jsonStringifyValue(content)

		if (serialized) return { helper: "writeLocalJSONFile", module: WRITERS, args: [serialized, path.text()] }

		const helper = isCertainlyText(content)
			? "writeLocalTextFile"
			: isCertainlyBytes(content)
				? "writeLocalBuffer"
				: "writeLocalFile"

		return { helper, module: WRITERS, args: [content.text(), path.text()] }
	},

	appendFileSync: (_call, args) => {
		if (args.length < 2 || args.length > 3) return null

		if (args.length === 3 && !isUTF8(args[2])) return null

		return { helper: "appendLocalTextFile", module: WRITERS, args: [args[1]!.text(), args[0]!.text()] }
	},

	mkdirSync: (call, args) => {
		// The created path is the difference between the two helpers' return values, so a call whose value is read is
		// asking a question neither answers the same way. An `await` in between is not a reader: `await mkdir(…)` as a
		// statement discards the same value `mkdirSync(…)` as a statement discards.
		const parent = call.parent()
		const statement = parent?.kind() === "await_expression" ? parent.parent() : parent

		if (statement?.kind() !== "expression_statement") return null

		if (args.length === 1) return { helper: "makeDirectoryExclusive", module: WRITERS, args: [args[0]!.text()] }

		if (optionsAre(args[1], "recursive")) {
			return { helper: "makeDirectories", module: WRITERS, args: [args[0]!.text()] }
		}

		return null
	},

	rmSync: (_call, args) => {
		const path = args[0]?.text()

		if (path === undefined) return null

		// The two removal helpers are told apart by which absence they forgive, so the options decide which one this was.
		if (optionsAre(args[1], "recursive", "force") || optionsAre(args[1], "force", "recursive")) {
			return { helper: "removePathIfPresent", module: WRITERS, args: [path] }
		}

		if (optionsAre(args[1], "force")) return { helper: "removePathIfPresent", module: WRITERS, args: [path] }

		if (optionsAre(args[1], "recursive") || args.length === 1) {
			return { helper: "removePath", module: WRITERS, args: [path] }
		}

		return null
	},

	unlinkSync: (_call, args) =>
		args.length === 1 ? { helper: "removePath", module: WRITERS, args: [args[0]!.text()] } : null,

	readdirSync: (_call, args) => {
		if (args.length === 1) return { helper: "readDirectory", module: READERS, args: [args[0]!.text()] }

		if (optionsAre(args[1], "withFileTypes")) {
			return { helper: "readDirectoryEntries", module: READERS, args: [args[0]!.text()] }
		}

		if (optionsAre(args[1], "recursive")) {
			return { helper: "readDirectoryRecursive", module: READERS, args: [args[0]!.text()] }
		}

		return null
	},

	statSync: (_call, args) =>
		args.length === 1 ? { helper: "statPath", module: READERS, args: [args[0]!.text()] } : null,

	lstatSync: (_call, args) =>
		args.length === 1 ? { helper: "statLink", module: READERS, args: [args[0]!.text()] } : null,

	realpathSync: (_call, args) =>
		args.length === 1 ? { helper: "realPath", module: READERS, args: [args[0]!.text()] } : null,

	renameSync: (_call, args) =>
		args.length === 2 ? { helper: "movePath", module: WRITERS, args: [args[0]!.text(), args[1]!.text()] } : null,

	copyFileSync: (_call, args) =>
		args.length === 2 ? { helper: "copyFileTo", module: WRITERS, args: [args[0]!.text(), args[1]!.text()] } : null,

	// `fs.cp` defaults `force` to true, so `{ recursive, force }` asks for what `{ recursive }` already gives.
	cpSync: (_call, args) =>
		args.length === 3 &&
		(optionsAre(args[2], "recursive") ||
			optionsAre(args[2], "recursive", "force") ||
			optionsAre(args[2], "force", "recursive"))
			? { helper: "copyPath", module: WRITERS, args: [args[0]!.text(), args[1]!.text()] }
			: null,

	symlinkSync: (_call, args) =>
		args.length === 2 || args.length === 3
			? { helper: "createSymbolicLink", module: WRITERS, args: args.map((argument) => argument.text()) }
			: null,

	chmodSync: (_call, args) =>
		args.length === 2 ? { helper: "changeMode", module: WRITERS, args: [args[0]!.text(), args[1]!.text()] } : null,

	utimesSync: (_call, args) =>
		args.length === 3
			? { helper: "setTimestamps", module: WRITERS, args: args.map((argument) => argument.text()) }
			: null,
}
