/**
 * Rewrite a synchronous `node:fs` call that stands inside an `async` function.
 *
 * Scope is that position and nothing else. A sync call inside a sync function is a CASCADE — its signature changes, and
 * so does every caller's — and a top-level call moves work to import time. Both are real, neither is mechanical, and
 * mixing them in would hide the decisions behind the renames.
 *
 * Every mapping is either equal to the builtin or a strict SUPERSET of it, and the supersets are named: the file
 * writers create the parent directory, `copyFileTo` and `createSymbolicLink` clear the destination first. Each succeeds
 * where the builtin threw and fails nowhere the builtin succeeded.
 *
 * Throwing and forgiving are never conflated. `statSync` becomes `statPath`, which raises ENOENT like the builtin, and
 * never `tryStat`, which answers null. `mkdirSync(p)` without `recursive` becomes `makeDirectoryExclusive`, not
 * `makeDirectories`: bare `mkdir` is an atomic test-and-set and is how this repository's inter-process locks are held,
 * so the idempotent helper would let every waiter take the lock at once.
 *
 * A shape the table cannot read is left alone.
 */

import type { Codemod, Edit, SgNode } from "codemod:ast-grep"
import type TSX from "codemod:ast-grep/langs/tsx"
import type TS from "codemod:ast-grep/langs/typescript"

type Lang = TS | TSX

/**
 * The modules a synchronous `node:fs` name may arrive from. A binding from anywhere else is left alone: this codemod
 * cannot verify that some other module's `existsSync` is the builtin.
 */
const SOURCE_MODULES = new Set(["@mailwoman/platform/fs", "node:fs", "fs"])

const READERS = "readers"
const WRITERS = "writers"

interface Plan {
	helper: string
	/**
	 * The type argument to carry across, spelled with its angle brackets.
	 *
	 * `parseJSONStrict<Manifest>(…)` states what the file holds, and `readLocalJSONFile` defaults to `Record<string,
	 * unknown>` without it. Dropping it turned 101 typed reads into untyped ones and the compiler reported the loss 254
	 * times, several frames downstream of the rewrite.
	 */
	typeArguments?: string
	module: typeof READERS | typeof WRITERS
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
function callArguments(call: SgNode<Lang>): SgNode<Lang>[] {
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
function optionsAre(node: SgNode<Lang> | undefined, ...expected: string[]): boolean {
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
function isUTF8(node: SgNode<Lang> | undefined): boolean {
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
function isCertainlyText(node: SgNode<Lang>): boolean {
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
function isCertainlyBytes(node: SgNode<Lang>): boolean {
	return /^(Buffer\.(from|alloc|concat)|new (Uint8Array|Buffer))\(/.test(node.text())
}

/**
 * The value a `JSON.stringify(…)` call serializes, when the call is a plain serialization this codemod can move to
 * {@linkcode writeLocalJSONFile}.
 *
 * A REPLACER — the second argument, when it is anything but `null` or `undefined` — chooses which keys survive, so the
 * output is not the value and the swap would silently change what is written.
 */
function jsonStringifyValue(node: SgNode<Lang>): string | undefined {
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
const JSON_PARSE_WRAPPERS = new Set(["JSON.parse", "parseJSONStrict"])

/**
 * The `WRAPPER(…)` call this filesystem read is the sole argument of, when that wrapper parses JSON.
 */
function jsonParseWrapper(call: SgNode<Lang>): SgNode<Lang> | undefined {
	const list = call.parent()

	if (list?.kind() !== "arguments") return undefined

	const outer = list.parent()

	if (outer?.kind() !== "call_expression") return undefined

	if (!JSON_PARSE_WRAPPERS.has(outer.field("function")?.text() ?? "")) return undefined

	// The sole argument. `JSON.parse(text, reviver)` transforms what it parses, and no reader here does that.
	return callArguments(outer).length === 1 ? outer : undefined
}

type Mapping = (call: SgNode<Lang>, args: SgNode<Lang>[]) => Plan | null

const MAPPINGS: Record<string, Mapping> = {
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
		// asking a question neither answers the same way.
		if (call.parent()?.kind() !== "expression_statement") return null

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

const FUNCTION_KINDS = new Set(["arrow_function", "function_declaration", "function_expression", "method_definition"])

/**
 * Node kinds that end an `async` scope without being a function: what they contain runs synchronously however the
 * surrounding function was declared.
 */
const SYNC_SCOPE_KINDS = new Set(["class_static_block", "get_accessor", "set_accessor"])

/**
 * Test-framework entry points whose callback the runner AWAITS, so marking one `async` costs nothing and makes an
 * `await` legal inside it. A census of this repository found 80 synchronous filesystem calls sitting in one.
 *
 * `describe` is deliberately absent. Vitest COLLECTS synchronously: an `async` describe body returns a promise the
 * collector never waits on, so every `it` inside it registers after collection has finished and the suite silently runs
 * zero tests.
 */
const AWAITED_CALLBACK_HOSTS = new Set(["afterAll", "afterEach", "beforeAll", "beforeEach", "bench", "it", "test"])

/**
 * The name of the function a callback was passed to, unwrapping the chained and called forms the test framework uses:
 * `it.each(rows)(…)` and `test.skipIf(cond)(…)` both host their callback under `it` and `test`.
 */
function callbackHost(fn: SgNode<Lang>): string | undefined {
	// An argument's parent is the `arguments` list, not the call — the call is one level above that.
	const list = fn.parent()

	if (!list || list.kind() !== "arguments") return undefined

	const call = list.parent()

	if (!call || call.kind() !== "call_expression") return undefined

	let host = call.field("function")

	while (host && (host.kind() === "member_expression" || host.kind() === "call_expression")) {
		host = host.kind() === "call_expression" ? host.field("function") : host.field("object")
	}

	return host?.kind() === "identifier" ? host.text() : undefined
}

/**
 * Function names this run is making `async` across the whole repository, supplied by `--param promote=a,b,c`.
 *
 * The per-file codemod cannot see that `readWofPaths` is called from eleven other packages, so on its own it refuses
 * every exported function. `scratchpad/codemod/promotion-set.ts` answers that question once as a repo-wide fixpoint —
 * upward through callers, downward through anything that cannot hold an `await` — and hands the answer in here.
 */
let promoteNames = new Set<string>()

/**
 * Path fragments naming files where a call at MODULE SCOPE may become a top-level `await`, supplied by `--param
 * topLevelAwait=…`.
 *
 * Off for everything by default. Top-level await makes a module's evaluation asynchronous, and this repository has
 * already had to undo one for cause (`packages/core/resources/libpostal.ts`, #481). It is safe where the file is an
 * ENTRY rather than an import — a `*.test.ts` vitest collects, a script run by `node` — and the caller says which those
 * are rather than the codemod guessing.
 */
let topLevelAwaitPaths: string[] = []

/**
 * Whether this file may hold a top-level `await`.
 */
function allowsTopLevelAwait(filename: string): boolean {
	return topLevelAwaitPaths.some((fragment) => filename.includes(fragment))
}

/**
 * The name a function is declared under, if it has one. The DECLARATION, not any ancestor: walking up names the arrow
 * inside `const rows = paths.map((p) => …)` as `rows`.
 */
function declaredName(fn: SgNode<Lang>): string | undefined {
	if (fn.kind() === "function_declaration" || fn.kind() === "method_definition") return fn.field("name")?.text()

	const parent = fn.parent()

	if (parent?.kind() !== "variable_declarator" || parent.field("value")?.id() !== fn.id()) return undefined

	const name = parent.field("name")

	return name?.kind() === "identifier" ? name.text() : undefined
}

interface Enclosing {
	/**
	 * The function the call stands in, or `undefined` at module scope.
	 */
	fn?: SgNode<Lang>
	/**
	 * Whether an `await` is legal there as the code stands.
	 */
	isAsync: boolean
	/**
	 * Whether marking that function `async` is free — a callback the test runner already awaits.
	 */
	promotable: boolean
	/**
	 * Whether this run is making that function `async` because the repo-wide set names it.
	 */
	inPromotionSet: boolean
}

/**
 * The nearest enclosing function, and what it would take to put an `await` inside it.
 */
function enclosing(call: SgNode<Lang>): Enclosing {
	for (const ancestor of call.ancestors()) {
		const kind = ancestor.kind()

		if (SYNC_SCOPE_KINDS.has(kind)) return { isAsync: false, promotable: false, inPromotionSet: false }

		if (FUNCTION_KINDS.has(kind)) {
			const isAsync = isAsyncFunction(ancestor)
			const host = callbackHost(ancestor)
			const name = declaredName(ancestor)

			return {
				fn: ancestor,
				isAsync,
				promotable: !isAsync && host !== undefined && AWAITED_CALLBACK_HOSTS.has(host),
				inPromotionSet: !isAsync && name !== undefined && promoteNames.has(name),
			}
		}
	}

	return { isAsync: false, promotable: false, inPromotionSet: false }
}

/**
 * The name a file-local function is bound to, and whether that binding leaves the file.
 */
interface LocalFunction {
	name: string
	fn: SgNode<Lang>
	/**
	 * The node an `async` keyword is inserted in front of.
	 */
	insertAt: number
	exported: boolean
	/**
	 * The `: T` annotation to rewrite as `: Promise<T>`, when there is one.
	 */
	returnType?: SgNode<Lang>
}

/**
 * Every function this file declares under a name, whether by `function f() {}` or `const f = () => {}`.
 */
function localFunctions(rootNode: SgNode<Lang>): Map<string, LocalFunction> {
	const found = new Map<string, LocalFunction>()

	for (const declaration of rootNode.findAll({ rule: { kind: "function_declaration" } })) {
		const name = declaration.field("name")?.text()

		if (!name) continue

		found.set(name, {
			name,
			fn: declaration,
			insertAt: declaration.range().start.index,
			exported: declaration.parent()?.kind() === "export_statement",
			returnType: declaration.field("return_type") ?? undefined,
		})
	}

	for (const declarator of rootNode.findAll({ rule: { kind: "variable_declarator" } })) {
		const name = declarator.field("name")
		const value = declarator.field("value")

		if (!name || name.kind() !== "identifier" || !value) continue

		if (value.kind() !== "arrow_function" && value.kind() !== "function_expression") continue

		// `const health: MailwomanAPIEngine["health"] = () => buildHealthData()` states a SYNCHRONOUS contract, and the
		// annotation is where it is stated. Promoting the function behind it satisfies no caller and breaks the
		// interface — measured: the cascade did exactly this and `() => Promise<HealthData>` stopped matching
		// `() => HealthData`.
		if (declarator.field("type")) continue

		const statement = declarator.parent()?.parent()

		found.set(name.text(), {
			name: name.text(),
			fn: value,
			insertAt: value.range().start.index,
			exported: statement?.kind() === "export_statement",
			returnType: value.field("return_type") ?? undefined,
		})
	}

	return found
}

/**
 * Whether an `await` already stands in front of this expression, through any number of parentheses.
 */
function alreadyAwaited(call: SgNode<Lang>): boolean {
	let node = call.parent()

	while (node?.kind() === "parenthesized_expression") {
		node = node.parent()
	}

	return node?.kind() === "await_expression"
}

function isAsyncFunction(fn: SgNode<Lang>): boolean {
	return fn.children().some((child) => child.kind() === "async" || child.text() === "async")
}

/**
 * The result of asking whether a file-local function can be made `async` without leaving the file.
 *
 * A cascade that stops halfway is worse than no cascade: an un-awaited promise where a value used to be is a silent
 * wrong answer, not a compile error in every position. So the closure is all-or-nothing — one caller that cannot take
 * an `await` refuses the whole set, and the reason names that caller.
 */
type Cascade =
	| { ok: true; functions: LocalFunction[]; callbacks: SgNode<Lang>[]; callSites: SgNode<Lang>[] }
	| { ok: false; reason: string }

/**
 * Every function that must become `async` for `seed` to become `async`, and every call site that must gain an `await`.
 *
 * Refuses when any of them is reached from a position where `await` is illegal: module scope, a class constructor, a
 * callback the caller does not await. Refuses too when a name is used as a VALUE rather than called — `paths.map(read)`
 * passes the function itself, and making it async changes what that expression produces.
 */
function cascade(rootNode: SgNode<Lang>, seed: LocalFunction, locals: Map<string, LocalFunction>): Cascade {
	const chosen = new Map<string, LocalFunction>()
	const callbacks: SgNode<Lang>[] = []
	const callSites: SgNode<Lang>[] = []
	const queue = [seed]

	while (queue.length) {
		const current = queue.shift()!

		if (chosen.has(current.name)) continue

		if (current.exported) return { ok: false, reason: `${current.name} is exported` }

		if (isAsyncFunction(current.fn)) continue

		chosen.set(current.name, current)

		for (const identifier of rootNode.findAll({ rule: { kind: "identifier", regex: `^${current.name}$` } })) {
			// The `const NAME =` binding and the `function NAME` name are the declaration, not a use. A call inside the
			// function's OWN body is a use, and the one that is easy to miss: a recursive `out.push(...walk(child))`
			// left un-awaited spreads a promise, which TypeScript reports as a missing `[Symbol.iterator]` several
			// frames from the cause.
			if (identifier.parent()?.kind() === "variable_declarator") continue

			if (identifier.parent()?.kind() === "function_declaration") continue

			const parent = identifier.parent()

			const call =
				parent?.kind() === "call_expression" && parent.field("function")?.id() === identifier.id() ? parent : undefined

			if (!call) return { ok: false, reason: `${current.name} is used as a value, not called` }

			const host = enclosing(call)

			if (host.isAsync) {
				callSites.push(call)

				continue
			}

			if (host.promotable && host.fn) {
				callbacks.push(host.fn)
				callSites.push(call)

				continue
			}

			if (!host.fn) return { ok: false, reason: `${current.name} is called at module scope` }

			const caller = [...locals.values()].find((candidate) => candidate.fn.id() === host.fn?.id())

			if (!caller) return { ok: false, reason: `${current.name} is called from a function this file cannot name` }

			callSites.push(call)
			queue.push(caller)
		}
	}

	return { ok: true, functions: [...chosen.values()], callbacks, callSites }
}

/**
 * `await` is a unary expression, so a parent that binds tighter needs the parentheses spelled out.
 */
const TIGHTER_BINDING_PARENTS = new Set([
	"await_expression",
	"call_expression",
	"member_expression",
	"non_null_expression",
	// `out.push(...await walk(x))` parses, but only a reader who knows `await` outranks spread can see that. The
	// parentheses cost nothing and remove the question.
	"spread_element",
	"subscript_expression",
	"template_substitution",
	"unary_expression",
])

function needsParentheses(call: SgNode<Lang>): boolean {
	const parent = call.parent()

	if (!parent) return false

	if (parent.kind() === "call_expression") return parent.field("function")?.id() === call.id()

	return TIGHTER_BINDING_PARENTS.has(parent.kind())
}

/**
 * Record that this file needs `helper` from `specifier`.
 */
function ensure(needed: Map<string, Set<string>>, specifier: string, helper: string): void {
	const helpers = needed.get(specifier) ?? new Set<string>()

	helpers.add(helper)
	needed.set(specifier, helpers)
}

/**
 * The specifier a file imports a core helper by. Inside `@mailwoman/core` the package cannot name itself.
 */
function coreSpecifier(filename: string, module: string): string {
	return filename.includes("/packages/core/") ? `#fs/${module}` : `@mailwoman/core/fs/${module}`
}

interface Binding {
	/**
	 * The `named_imports` or `object_pattern` node holding the specifiers.
	 */
	holder: SgNode<Lang>
	/**
	 * Every local name it binds.
	 */
	names: string[]
}

/**
 * Every place this file binds a name from a recognized module — a static `import`, and the `await import("…")`
 * destructuring the Ink commands use to keep a Node builtin out of a bundle.
 *
 * The dynamic form is invisible to an import-declaration query, which is exactly how a first pass over this repository
 * left 43 call sites untouched.
 */
function syncBindings(rootNode: SgNode<Lang>): Binding[] {
	const bindings: Binding[] = []

	for (const statement of rootNode.findAll({ rule: { kind: "import_statement" } })) {
		const source = statement.field("source")?.text().slice(1, -1)

		if (source === undefined || !SOURCE_MODULES.has(source)) continue

		const holder = statement.find({ rule: { kind: "named_imports" } })

		if (!holder) continue

		bindings.push({ holder, names: specifierNames(holder) })
	}

	for (const declarator of rootNode.findAll({ rule: { kind: "variable_declarator" } })) {
		const name = declarator.field("name")
		const value = declarator.field("value")

		if (!name || name.kind() !== "object_pattern" || !value) continue

		const call = value.kind() === "await_expression" ? value.children().find((child) => child.isNamed()) : value

		if (!call || call.kind() !== "call_expression") continue

		if (call.field("function")?.text() !== "import") continue

		const source = callArguments(call)[0]?.text().slice(1, -1)

		if (source === undefined || !SOURCE_MODULES.has(source)) continue

		bindings.push({ holder: name, names: specifierNames(name) })
	}

	return bindings
}

/**
 * Local names that alias a whole source module, so `fs.readFileSync(…)` is the builtin under another spelling.
 *
 * Three shapes, and the third is the one that hid eight call sites in `packages/neural/classifier.ts`: a Node-only
 * module reached through a PARALLEL dynamic import, where the binding is one element of an array pattern destructured
 * from `Promise.all`. Its position in the array is what ties the name to the module.
 */
function namespaceBindings(rootNode: SgNode<Lang>): Set<string> {
	const names = new Set<string>()

	for (const statement of rootNode.findAll({ rule: { kind: "import_statement" } })) {
		const source = statement.field("source")?.text().slice(1, -1)

		if (source === undefined || !SOURCE_MODULES.has(source)) continue

		const namespace = statement.find({ rule: { kind: "namespace_import" } })
		const alias = namespace?.children().find((child) => child.kind() === "identifier")

		if (alias) {
			names.add(alias.text())
		}
	}

	for (const declarator of rootNode.findAll({ rule: { kind: "variable_declarator" } })) {
		const name = declarator.field("name")
		const value = declarator.field("value")

		if (!name || !value) continue

		const awaited = value.kind() === "await_expression" ? value.children().find((child) => child.isNamed()) : value

		if (!awaited || awaited.kind() !== "call_expression") continue

		// `const fs = await import("…")`
		const direct = importSource(awaited)

		if (direct !== undefined) {
			if (name.kind() === "identifier" && SOURCE_MODULES.has(direct)) {
				names.add(name.text())
			}

			continue
		}

		if (name.kind() !== "array_pattern") continue

		if (awaited.field("function")?.text() !== "Promise.all") continue

		const list = callArguments(awaited)[0]

		if (!list || list.kind() !== "array") continue

		const imports = list.children().filter((child) => child.isNamed())
		const targets = name.children().filter((child) => child.isNamed())

		for (const [index, entry] of imports.entries()) {
			const source = importSource(entry)
			const binding = targets[index]

			if (source === undefined || !SOURCE_MODULES.has(source)) continue

			if (binding?.kind() === "identifier" || binding?.kind() === "shorthand_property_identifier_pattern") {
				names.add(binding.text())
			}
		}
	}

	return names
}

/**
 * The module specifier of an `import("…")` expression, or `undefined` for anything else.
 */
function importSource(node: SgNode<Lang>): string | undefined {
	if (node.kind() !== "call_expression") return undefined

	if (node.field("function")?.kind() !== "import") return undefined

	const specifier = callArguments(node)[0]

	return specifier?.kind() === "string" ? specifier.text().slice(1, -1) : undefined
}

/**
 * The local names a `named_imports` or `object_pattern` binds. An aliased specifier binds its alias.
 */
function specifierNames(holder: SgNode<Lang>): string[] {
	return specifiers(holder).map((entry) => entry.name)
}

/**
 * Each specifier a holder binds, as the local NAME it introduces and the SOURCE TEXT that introduces it.
 *
 * The two differ wherever a specifier carries a modifier or an alias — `type TemporaryDirectory`, `x as y` — and
 * rebuilding a clause from names alone drops that half. Rebuilt from names, `type TemporaryDirectory` came back as a
 * value import, which `verbatimModuleSyntax` then emits into the bundle.
 */
function specifiers(holder: SgNode<Lang>): Array<{ name: string; text: string }> {
	return holder
		.children()
		.filter((child) => child.kind() === "import_specifier" || child.kind() === "shorthand_property_identifier_pattern")
		.map((child) => {
			const bound = child.kind() === "import_specifier" ? (child.field("alias") ?? child.field("name")) : child

			return bound ? { name: bound.text(), text: child.text() } : undefined
		})
		.filter((entry): entry is { name: string; text: string } => entry !== undefined)
}

/**
 * Whether a name is still read once the planned rewrites land.
 *
 * `excluded` carries the holders that bind the name AND the call expressions this run is replacing. The second half is
 * the one that is easy to miss: JSSG defers every edit to `commitEdits`, so the tree being queried here is the ORIGINAL
 * source, in which each rewritten call still names the sync binding. Without it the import always looks live and is
 * never pruned.
 */
function isReferenced(rootNode: SgNode<Lang>, name: string, excluded: SgNode<Lang>[]): boolean {
	// `type_identifier` as well as `identifier`: a name used only in a type position — `let scratch: TemporaryDirectory`
	// — never appears as an expression, and counting expressions alone reported three live type imports as dead.
	return rootNode
		.findAll({ rule: { any: [{ kind: "identifier" }, { kind: "type_identifier" }], regex: `^${name}$` } })
		.some((identifier) => !excluded.some((outer) => withinRange(outer, identifier)))
}

function withinRange(outer: SgNode<Lang>, inner: SgNode<Lang>): boolean {
	return inner.range().start.index >= outer.range().start.index && inner.range().end.index <= outer.range().end.index
}

/**
 * Node kinds that may precede a file's first statement and must stay above any inserted import.
 *
 * `hash_bang_line` is the one that bites: a shebang is not a comment in the grammar, and an import placed above it
 * stops the file being executable at all.
 */
const PREAMBLE_KINDS = new Set(["comment", "hash_bang_line"])

/**
 * Where the file's code begins: the start of the first top-level node that is not preamble.
 */
function firstStatementIndex(rootNode: SgNode<Lang>): number {
	const first = rootNode.children().find((child) => child.isNamed() && !PREAMBLE_KINDS.has(child.kind()))

	return first ? first.range().start.index : 0
}

/**
 * Everything one file's rewrite accumulates. The transform is five passes over the same tree, and each needs what the
 * one before it recorded — the alternative is one function the complexity limit rightly refuses.
 */
interface Pass {
	root: Parameters<Codemod<Lang>>[0]
	rootNode: SgNode<Lang>
	edits: Edit[]
	/**
	 * Helper names this file must import, by module specifier.
	 */
	needed: Map<string, Set<string>>
	/**
	 * Nodes this run replaces, so a name inside one no longer counts as a live reference.
	 */
	replaced: SgNode<Lang>[]
	/**
	 * Synchronous names this run rewrote, so their import can be pruned.
	 */
	rewritten: Set<string>
	/**
	 * Functions to mark `async`, keyed by start offset so one holding several rewritten calls is marked once. Two edits
	 * inserting the same keyword at the same position would otherwise produce `async async () => {`.
	 */
	promoted: Map<number, SgNode<Lang>>
	asyncified: Map<number, LocalFunction>
	awaited: Map<number, SgNode<Lang>>
	locals: Map<string, LocalFunction>
	/**
	 * One answer per function, not per call: a function with four filesystem calls asks the same question four times, and
	 * a refusal has to be as sticky as an acceptance or the file gets half a cascade.
	 */
	cascades: Map<string, Cascade>
	bindings: Binding[]
	namespaces: Set<string>
	bound: Set<string>
}

function collapseJSONSpellings(pass: Pass): void {
	const { root, rootNode, edits, needed, replaced } = pass

	// Collapse a JSON read or write that is already asynchronous but still spells the serialization out. These are the
	// campaign's OWN output: an earlier pass turned `parseJSONStrict(readFileSync(p, "utf8"))` into
	// `parseJSONStrict(await readLocalTextFile(p))`, which is one helper short of what it means.
	//
	// The write changes bytes — `writeLocalJSONFile` is tab-indented with a trailing newline where `JSON.stringify(x)`
	// is compact — so an artifact compared by digest is compared against a new digest.
	for (const call of rootNode.findAll({ rule: { kind: "call_expression" } })) {
		const callee = call.field("function")?.text()

		if (callee !== undefined && JSON_PARSE_WRAPPERS.has(callee)) {
			const args = callArguments(call)
			const inner = args.length === 1 ? args[0] : undefined
			const read = inner?.kind() === "await_expression" ? inner.children().find((child) => child.isNamed()) : undefined

			if (read?.kind() === "call_expression" && read.field("function")?.text() === "readLocalTextFile") {
				const paths = callArguments(read).map((argument) => argument.text())
				const typeArguments = call.field("type_arguments")?.text() ?? ""
				const expression = `await readLocalJSONFile${typeArguments}(${paths.join(", ")})`

				edits.push(call.replace(needsParentheses(call) ? `(${expression})` : expression))
				replaced.push(call)
				ensure(needed, coreSpecifier(root.filename(), READERS), "readLocalJSONFile")

				continue
			}
		}

		if (callee !== "writeLocalTextFile" && callee !== "writeLocalFile") continue

		const args = callArguments(call)
		const serialized = args[0] ? jsonStringifyValue(args[0]) : undefined

		if (!serialized || args.length < 2) continue

		const rest = args.slice(1).map((argument) => argument.text())

		edits.push(call.replace(`writeLocalJSONFile(${[serialized, ...rest].join(", ")})`))
		replaced.push(call)
		ensure(needed, coreSpecifier(root.filename(), WRITERS), "writeLocalJSONFile")
	}
}

function applyPromotionSet(pass: Pass): void {
	const { rootNode, locals, promoted, asyncified, awaited } = pass

	// The repo-wide set, applied first and independently of whether this file touches the filesystem at all: a file that
	// only CALLS a promoted function still needs its `await`, and by the set's construction every enclosing function of
	// such a call is itself in the set, already `async`, or a callback the runner awaits.
	for (const [name, local] of locals) {
		if (!promoteNames.has(name) || isAsyncFunction(local.fn)) continue

		asyncified.set(local.insertAt, local)
	}

	for (const call of rootNode.findAll({ rule: { kind: "call_expression" } })) {
		const callee = call.field("function")

		if (!callee || callee.kind() !== "identifier") continue

		if (!promoteNames.has(callee.text())) continue

		// Idempotence. Unlike the filesystem rewrite — where the synchronous name is gone after one pass, so a second
		// pass finds nothing — awaiting a call to a promoted name matches again every time. A second run produced
		// `await (await resolveShardPath(…))`, which is what a re-processed file looks like.
		if (alreadyAwaited(call)) continue

		const host = enclosing(call)

		if (host.promotable && host.fn) {
			promoted.set(host.fn.range().start.index, host.fn)
		}

		awaited.set(call.range().start.index, call)
	}
}

function rewriteFilesystemCalls(pass: Pass): void {
	const {
		root,
		rootNode,
		edits,
		needed,
		replaced,
		rewritten,
		promoted,
		asyncified,
		awaited,
		locals,
		cascades,
		namespaces,
		bound,
	} = pass

	for (const call of rootNode.findAll({ rule: { kind: "call_expression" } })) {
		const callee = call.field("function")

		if (!callee) continue

		// Two spellings of the same builtin: a named import (`readFileSync(…)`) and a whole-module alias
		// (`fs.readFileSync(…)`). The second is how a Node-only module reaches a file the bundler also reads.
		let name: string | undefined

		if (callee.kind() === "identifier" && bound.has(callee.text())) {
			name = callee.text()
		} else if (callee.kind() === "member_expression" && namespaces.has(callee.field("object")?.text() ?? "")) {
			name = callee.field("property")?.text()
		}

		if (!name) continue

		const mapping = MAPPINGS[name]

		if (!mapping) continue

		const host = enclosing(call)
		let plannedCascade: Cascade | undefined

		// At module scope in a file the caller marked an entry, the `await` is legal as it stands.
		const topLevel = !host.fn && allowsTopLevelAwait(root.filename())

		if (!topLevel && !host.isAsync && !host.promotable && !host.inPromotionSet) {
			// The call stands in a plain synchronous function. It can still move, but only if that function and every
			// caller of it inside this file can become `async` — which `cascade` answers all-or-nothing.
			const owner = host.fn && [...locals.values()].find((candidate) => candidate.fn.id() === host.fn?.id())

			if (!owner) continue

			plannedCascade = cascades.get(owner.name) ?? cascade(rootNode, owner, locals)
			cascades.set(owner.name, plannedCascade)

			if (!plannedCascade.ok) continue
		}

		const plan = mapping(call, callArguments(call))

		if (!plan) continue

		if (host.promotable && host.fn) {
			promoted.set(host.fn.range().start.index, host.fn)
		}

		if (plannedCascade?.ok) {
			for (const fn of plannedCascade.functions) {
				asyncified.set(fn.insertAt, fn)
			}

			for (const callback of plannedCascade.callbacks) {
				promoted.set(callback.range().start.index, callback)
			}

			for (const site of plannedCascade.callSites) {
				awaited.set(site.range().start.index, site)
			}
		}

		const target = plan.replaces ?? call
		const expression = `await ${plan.helper}${plan.typeArguments ?? ""}(${plan.args.join(", ")})`

		edits.push(target.replace(needsParentheses(target) ? `(${expression})` : expression))
		replaced.push(target)
		rewritten.add(name)

		ensure(needed, coreSpecifier(root.filename(), plan.module), plan.helper)
	}
}

function emitAsyncMarkers(pass: Pass): void {
	const { edits, promoted, asyncified, awaited } = pass

	for (const fn of promoted.values()) {
		edits.push({ startPos: fn.range().start.index, endPos: fn.range().start.index, insertedText: "async " })
	}

	for (const local of asyncified.values()) {
		if (promoted.has(local.insertAt)) continue

		edits.push({ startPos: local.insertAt, endPos: local.insertAt, insertedText: "async " })

		// `: string` becomes `: Promise<string>`. A function with no annotation needs no edit — TypeScript infers the
		// promise — and one already answering a promise is left as it is rather than double-wrapped.
		const annotation = local.returnType?.text().replace(/^:\s*/, "")

		if (annotation && !annotation.startsWith("Promise<")) {
			edits.push(local.returnType!.replace(`: Promise<${annotation}>`))
		}
	}

	// Inserted at the boundaries rather than replacing the call's text: a cascade call site can CONTAIN a rewritten
	// filesystem call in one of its arguments, and replacing the outer node's original text would both clobber that
	// inner edit and hand `commitEdits` two overlapping ranges.
	for (const site of awaited.values()) {
		const { start, end } = site.range()
		const wrap = needsParentheses(site)

		edits.push({ startPos: start.index, endPos: start.index, insertedText: wrap ? "(await " : "await " })

		if (wrap) {
			edits.push({ startPos: end.index, endPos: end.index, insertedText: ")" })
		}
	}
}

function reconcileImports(pass: Pass): void {
	const { rootNode, edits, needed, replaced, bindings } = pass

	// Every rewritten call has become `await helper(…)`, so the sync name may now be dead. Counted on identifiers rather
	// than on the text, so an occurrence in a comment or a string does not keep a binding alive.
	const excluded = [...bindings.map((binding) => binding.holder), ...replaced]

	for (const binding of bindings) {
		const survivors = binding.names.filter((name) => isReferenced(rootNode, name, excluded))

		if (survivors.length === binding.names.length) continue

		if (survivors.length) {
			edits.push(
				binding.holder.replace(
					`{ ${specifiers(binding.holder)
						.filter((entry) => survivors.includes(entry.name))
						.map((entry) => entry.text)
						.join(", ")} }`
				)
			)

			continue
		}

		// Nothing survives, so the statement's only purpose is gone. Both shapes go — a named-imports-only `import`, and
		// a `const { … } = await import("…")` whose every binding is dead — because the modules this codemod reads from
		// are the `node:fs` mirror and the JSON helpers, and evaluating one has no effect worth keeping. A default or
		// namespace binding beside the names is still live, and keeps its statement.
		if (binding.holder.kind() === "object_pattern") {
			const declarator = binding.holder.parent()
			const statement = declarator?.parent()

			if (declarator?.kind() !== "variable_declarator") continue

			if (statement?.kind() !== "lexical_declaration" && statement?.kind() !== "variable_declaration") continue

			// One declarator only. `const { rm } = await import(…), other = 1` would lose `other` with the statement.
			if (statement.children().filter((child) => child.kind() === "variable_declarator").length !== 1) continue

			edits.push(statement.replace(""))

			continue
		}

		const statement = binding.holder.parent()?.parent()

		if (
			binding.holder.kind() !== "named_imports" ||
			statement?.kind() !== "import_statement" ||
			specifierNames(binding.holder).length !== binding.names.length ||
			binding.holder
				.parent()
				?.children()
				.filter((child) => child.isNamed()).length !== 1
		) {
			continue
		}

		edits.push(statement.replace(""))
	}

	// An existing import of the same module absorbs the new names. A second `import … from "@mailwoman/core/fs/writers"`
	// beside the first is legal and no formatter merges it, so the file would carry the duplicate for good.
	for (const statement of rootNode.findAll({ rule: { kind: "import_statement" } })) {
		const specifier = statement.field("source")?.text().slice(1, -1)
		const helpers = specifier === undefined ? undefined : needed.get(specifier)
		const holder = statement.find({ rule: { kind: "named_imports" } })

		if (!holder || !specifier) continue

		// `@mailwoman/core/objects` joins the fs modules here because the JSON collapse CONSUMES `parseJSONStrict`:
		// the wrapper disappears into `readLocalJSONFile`, and its import would sit unread in every file it touched.
		if (!helpers && !/^(@mailwoman\/core\/|#)(fs\/|objects$)/.test(specifier)) continue

		// Existing specifiers are filtered before the new names are folded in: the collapse orphans CORE helpers as well
		// as synchronous ones — `parseJSONStrict(await readLocalTextFile(p))` becoming `readLocalJSONFile(p)` leaves
		// `readLocalTextFile` imported and unread — and pruning in a second pass would fight this edit for the same node.
		const before = specifiers(holder)
		const survivors = before.filter((entry) => isReferenced(rootNode, entry.name, [holder, ...replaced]))
		const kept = new Set(survivors.map((entry) => entry.name))
		const additions = [...(helpers ?? [])].filter((name) => !kept.has(name)).toSorted()

		// Survivors keep their ORIGINAL order and their original text; only the new names are sorted, and appended. A
		// rebuild that re-sorts everything rewrites 296 files that needed nothing.
		const merged = [...survivors.map((entry) => entry.text), ...additions]

		if (merged.length === before.length && !additions.length) {
			needed.delete(specifier)

			continue
		}

		// Nothing survives. A named-imports-only statement goes with its last name; anything carrying a default or a
		// namespace binding keeps the statement, because that binding is still live.
		if (!merged.length) {
			const clause = holder.parent()

			if (clause?.children().filter((child) => child.isNamed()).length === 1) {
				edits.push(statement.replace(""))
			}

			continue
		}

		edits.push(holder.replace(`{ ${merged.join(", ")} }`))
		needed.delete(specifier)
	}
}

const codemod: Codemod<Lang> = async (root, options) => {
	const rootNode = root.root()

	const params = options?.params as Record<string, unknown> | undefined

	promoteNames = new Set(
		String(params?.promote ?? "")
			.split(",")
			.filter(Boolean)
	)

	topLevelAwaitPaths = String(params?.topLevelAwait ?? "")
		.split(",")
		.filter(Boolean)

	const bindings = syncBindings(rootNode)
	const namespaces = namespaceBindings(rootNode)
	const bound = new Set(bindings.flatMap((binding) => binding.names))
	const edits: Edit[] = []
	const rewritten = new Set<string>()
	const replaced: SgNode<Lang>[] = []
	const needed = new Map<string, Set<string>>()

	// Keyed by start offset so a function holding several rewritten calls is marked `async` once. Two edits inserting
	// the same keyword at the same position would otherwise produce `async async () => {`.
	const promoted = new Map<number, SgNode<Lang>>()
	const asyncified = new Map<number, LocalFunction>()
	const awaited = new Map<number, SgNode<Lang>>()
	const locals = localFunctions(rootNode)

	// One answer per function, not per call: a function with four filesystem calls asks the same question four times,
	// and a refusal has to be as sticky as an acceptance or the file gets half a cascade.
	const cascades = new Map<string, Cascade>()

	const pass: Pass = {
		root,
		rootNode,
		edits,
		needed,
		replaced,
		rewritten,
		promoted,
		asyncified,
		awaited,
		locals,
		cascades,
		bindings,
		namespaces,
		bound,
	}

	collapseJSONSpellings(pass)
	applyPromotionSet(pass)
	rewriteFilesystemCalls(pass)
	emitAsyncMarkers(pass)

	// Reconciliation runs unconditionally, and the guard below reads its edits too: a file whose only defect is an
	// import an EARLIER pass left unread has nothing for the transform to match on, and would otherwise never be
	// reached. Forty-eight such bindings survived the campaign that produced them.
	reconcileImports(pass)

	if (!edits.length) return null

	// Sorted by MODULE, not by the rendered line: sorting the finished strings orders files by whichever helper happens
	// to come first alphabetically, which is not an order a reader can predict.
	const added = [...needed]
		.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([specifier, helpers]) => `import { ${[...helpers].toSorted().join(", ")} } from "${specifier}"`)
		.join("\n")

	// Inserted as a block above the first statement rather than merged into the existing import list: placement within
	// that list is the formatter's job, and a codemod with an opinion about it would fight `oxfmt` on every file it
	// touches. Above the first STATEMENT, not at index 0 — every file in this repository opens with a `@copyright`
	// block comment, and an import wedged above it is the one edit a reviewer notices in all 260 files.
	if (!added) return rootNode.commitEdits(edits)

	const anchor = firstStatementIndex(rootNode)

	// When the orphaned import being deleted IS that first statement, the two edits share an offset and `commitEdits`
	// keeps one of them — measured: the inserted block was the one that vanished. So the block becomes that edit's
	// replacement text, standing exactly where the import it replaces stood, and inheriting its blank line.
	const atAnchor = edits.find((edit) => edit.startPos === anchor)

	if (atAnchor) {
		atAnchor.insertedText = added + atAnchor.insertedText
	} else {
		edits.push({ startPos: anchor, endPos: anchor, insertedText: `${added}\n\n` })
	}

	return rootNode.commitEdits(edits)
}

export default codemod
