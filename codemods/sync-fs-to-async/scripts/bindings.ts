/**
 * Read a file's import graph: which names arrive from the `node:fs` mirror and its promises sibling, under which
 * spelling, and where a new import may be inserted.
 *
 * Separated from `codemod.ts` because it answers one question and the five passes answer another. It also carries this
 * codemod's two hardest-won rules. A binding can arrive through `await import("…")` destructuring, which an
 * import-declaration query cannot see — that shape left 43 call sites untouched on the first run over this repository.
 * And a file's leading `/**` block is a NAMED node rather than trivia, so the insertion point must step over `comment`
 * and `hash_bang_line` alike; computing it wrongly is how a rewrite silently deletes a file's header.
 */

import type { SgNode } from "codemod:ast-grep"

import { callArguments, type Lang } from "./mappings.ts"

/**
 * The modules a synchronous `node:fs` name may arrive from. A binding from anywhere else is left alone: this codemod
 * cannot verify that some other module's `existsSync` is the builtin.
 */
export const SOURCE_MODULES = new Set(["node:fs", "fs"])

/**
 * The PROMISES mirror. Its names already answer a promise, so a rewrite here adds no `await` — the call site already
 * has whatever handling it needs, whether that is an `await`, a `.then`, or a slot in `Promise.all`.
 */
export const PROMISE_MODULES = new Set(["node:fs/promises"])

export interface Binding {
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
export function syncBindings(rootNode: SgNode<Lang>): Binding[] {
	const bindings: Binding[] = []

	for (const statement of rootNode.findAll({ rule: { kind: "import_statement" } })) {
		const source = statement.field("source")?.text().slice(1, -1)

		if (source === undefined || !(SOURCE_MODULES.has(source) || PROMISE_MODULES.has(source))) continue

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

		if (source === undefined || !(SOURCE_MODULES.has(source) || PROMISE_MODULES.has(source))) continue

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
export function namespaceBindings(rootNode: SgNode<Lang>): Set<string> {
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
export function importSource(node: SgNode<Lang>): string | undefined {
	if (node.kind() !== "call_expression") return undefined

	if (node.field("function")?.kind() !== "import") return undefined

	const specifier = callArguments(node)[0]

	return specifier?.kind() === "string" ? specifier.text().slice(1, -1) : undefined
}

/**
 * The names this file binds from the PROMISES mirror, so `readFile` can be told from a same-named local helper.
 */
export function promiseBindings(rootNode: SgNode<Lang>): Set<string> {
	const names = new Set<string>()

	// The deferred form too — `const { readFile } = await import("node:fs/promises")` is how a
	// Node-only module reaches a file the bundler also reads, and it is invisible to an import-statement query.
	for (const declarator of rootNode.findAll({ rule: { kind: "variable_declarator" } })) {
		const name = declarator.field("name")
		const value = declarator.field("value")

		if (!name || name.kind() !== "object_pattern" || !value) continue

		const call = value.kind() === "await_expression" ? value.children().find((child) => child.isNamed()) : value

		if (!call || call.kind() !== "call_expression") continue

		if (call.field("function")?.text() !== "import") continue

		const source = callArguments(call)[0]?.text().slice(1, -1)

		if (source === undefined || !PROMISE_MODULES.has(source)) continue

		for (const bound of specifierNames(name)) {
			names.add(bound)
		}
	}

	for (const statement of rootNode.findAll({ rule: { kind: "import_statement" } })) {
		const source = statement.field("source")?.text().slice(1, -1)

		if (source === undefined || !PROMISE_MODULES.has(source)) continue

		const holder = statement.find({ rule: { kind: "named_imports" } })

		if (holder) {
			for (const name of specifierNames(holder)) {
				names.add(name)
			}
		}
	}

	return names
}

/**
 * The local names a `named_imports` or `object_pattern` binds. An aliased specifier binds its alias.
 */
export function specifierNames(holder: SgNode<Lang>): string[] {
	return specifiers(holder).map((entry) => entry.name)
}

/**
 * Each specifier a holder binds, as the local NAME it introduces and the SOURCE TEXT that introduces it.
 *
 * The two differ wherever a specifier carries a modifier or an alias — `type TemporaryDirectory`, `x as y` — and
 * rebuilding a clause from names alone drops that half. Rebuilt from names, `type TemporaryDirectory` came back as a
 * value import, which `verbatimModuleSyntax` then emits into the bundle.
 */
export function specifiers(holder: SgNode<Lang>): Array<{ name: string; text: string }> {
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
export function isReferenced(rootNode: SgNode<Lang>, name: string, excluded: SgNode<Lang>[]): boolean {
	// `type_identifier` as well as `identifier`: a name used only in a type position — `let scratch: TemporaryDirectory`
	// — never appears as an expression, and counting expressions alone reported three live type imports as dead.
	return rootNode
		.findAll({ rule: { any: [{ kind: "identifier" }, { kind: "type_identifier" }], regex: `^${name}$` } })
		.some((identifier) => !excluded.some((outer) => withinRange(outer, identifier)))
}

export function withinRange(outer: SgNode<Lang>, inner: SgNode<Lang>): boolean {
	return inner.range().start.index >= outer.range().start.index && inner.range().end.index <= outer.range().end.index
}

/**
 * Node kinds that may precede a file's first statement and must stay above any inserted import.
 *
 * `hash_bang_line` is the one that bites: a shebang is not a comment in the grammar, and an import placed above it
 * stops the file being executable at all.
 */
export const PREAMBLE_KINDS = new Set(["comment", "hash_bang_line"])

/**
 * Where the file's code begins: the start of the first top-level node that is not preamble.
 */
export function firstStatementIndex(rootNode: SgNode<Lang>): number {
	const first = rootNode.children().find((child) => child.isNamed() && !PREAMBLE_KINDS.has(child.kind()))

	return first ? first.range().start.index : 0
}
