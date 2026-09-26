import { runFileSync } from "@mailwoman/core/process"
import type { PathBuilderLike } from "path-ts"
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Finds existing declarations of a function name across the monorepo.
 */

/**
 * Matches a top-level function declaration; the pattern anchors to column zero
 * because an indented declaration sits in a nested scope no other consumer can reuse.
 */
const FUNCTION_PATTERN = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm

/**
 * Matches a top-level constant whose value is a function; the lazy type annotation keeps
 * an `=>` inside an annotation from ending the match, and the right-hand side must
 * start with `function`, `(` or a type parameter to exclude lookup tables.
 */
const FUNCTION_CONSTANT_PATTERN =
	/^(?:export\s+)?const\s+(\w+)\s*(?::.*?)?=\s*(?:async\s+)?(?:function\b|\(|<[A-Za-z])/gm

/**
 * Returns the top-level function names that a source text declares.
 */
export function extractDeclaredSymbols(source: string): string[] {
	const names = new Set<string>()

	for (const pattern of [FUNCTION_PATTERN, FUNCTION_CONSTANT_PATTERN]) {
		for (const match of source.matchAll(pattern)) {
			if (match[1]) {
				names.add(match[1])
			}
		}
	}

	return [...names]
}

/**
 * One place where a name is declared.
 */
export interface DeclarationSite {
	/**
	 * The repository-relative file path.
	 */
	file: string
	line: number
	/**
	 * True when the declaration is exported, so other modules can import it.
	 */
	exported: boolean
	/**
	 * The declaration line, which shows the signature.
	 */
	text: string
}

/**
 * Options for the declaration searches.
 */
export interface FindDeclarationsOptions {
	cwd: PathBuilderLike
	/**
	 * The ripgrep executable; tests override it to exercise the missing-binary path.
	 */
	binary?: string
	/**
	 * The paths to search; the default is the whole tree, which ripgrep filters by `.gitignore`.
	 */
	searchPaths?: readonly string[]
}

/**
 * The exit code `rg` uses when the search ran and found no match.
 */
const RIPGREP_NO_MATCH = 1

/**
 * Matches ripgrep's `path:line:text` output lines.
 */
const OUTPUT_LINE_PATTERN = /^([^\n:]+):(\d+):(.*)$/gm

/**
 * Returns true for a bare identifier; search patterns are built only from identifiers,
 * so they need no regex escaping.
 */
function isIdentifier(name: string): boolean {
	return /^\w+$/.test(name)
}

/**
 * Splits an identifier into its camelCase components, keeping an acronym as one component
 * and attaching digits to the capitals before them, so `getH3Cell` yields `H3`.
 */
function nameComponents(name: string): string[] {
	return name.match(/[A-Z]+\d*(?![a-z])|[A-Z]?[a-z0-9]+|[A-Z]/gu) ?? []
}

/**
 * The minimum number of components in a contained name; the floor is two
 * because single components such as `read` match almost every name.
 */
const COMPONENT_FLOOR = 2

/**
 * Returns the shorter names contained in a name — every contiguous run of at least `floor` components,
 * excluding the whole name — because a duplicate often adds an affix to an existing name;
 * the search runs one way only, so writing a shorter name does not report a longer one.
 */
export function containedNameCandidates(name: string, floor = COMPONENT_FLOOR): string[] {
	const components = nameComponents(name)
	const candidates = new Set<string>()

	for (let start = 0; start < components.length; start += 1) {
		for (let end = start + floor; end <= components.length; end += 1) {
			if (end - start === components.length) continue

			const [head = "", ...rest] = components.slice(start, end)

			// The first component is lowercased as a name would be, since a component
			// starting with a digit cannot start a name.
			if (/^\d/u.test(head)) continue

			const leading = /^[A-Z]+\d*$/u.test(head) ? head.toLowerCase() : head.charAt(0).toLowerCase() + head.slice(1)

			candidates.add(leading + rest.join(""))
		}
	}

	return [...candidates]
}

/**
 * Returns every top-level declaration of each name and of the shorter names each one
 * contains; a name with no declaration has no key in the map.
 */
export function findDeclarations(
	names: readonly string[],
	{ cwd, searchPaths = ["."], binary = "rg" }: FindDeclarationsOptions
): Map<string, DeclarationSite[]> {
	const found = new Map<string, DeclarationSite[]>()
	const searchable = names.filter(isIdentifier)

	if (!searchable.length) return found

	const wanted = new Set(searchable)

	for (const name of searchable) {
		for (const candidate of containedNameCandidates(name)) {
			if (isIdentifier(candidate)) {
				wanted.add(candidate)
			}
		}
	}

	const alternation = [...wanted].join("|")

	// The search ignores case because a candidate's first component was capitalized in the longer name.
	const output = runRipgrep(declarationPatterns(`(?:${alternation})`), cwd, searchPaths, { binary, ignoreCase: true })

	const lowered = new Set([...wanted].map((name) => name.toLowerCase()))

	return collectSites(output, (name) => lowered.has(name.toLowerCase()))
}

/**
 * Returns the two declaration patterns with `nameExpression` in the name position;
 * callers build it from `\w` and identifiers, so it needs no escaping.
 */
function declarationPatterns(nameExpression: string): string[] {
	return [
		`^(?:export\\s+)?(?:async\\s+)?function\\s+${nameExpression}\\b`,
		`^(?:export\\s+)?const\\s+${nameExpression}\\s*(?::.*?)?=\\s*(?:async\\s+)?(?:function\\b|\\(|<[A-Za-z])`,
	]
}

/**
 * Groups ripgrep's output lines into sites by name, keeping only names `accept` allows and taking
 * the name from `extractDeclaredSymbols` so both functions share one definition of a declaration.
 */
function collectSites(output: string, accept: (name: string) => boolean): Map<string, DeclarationSite[]> {
	const found = new Map<string, DeclarationSite[]>()

	for (const match of output.matchAll(OUTPUT_LINE_PATTERN)) {
		const [, file, lineNumber, text = ""] = match
		const name = extractDeclaredSymbols(text)[0]

		if (!file || !lineNumber || !name || !accept(name)) continue

		const sites = found.get(name) ?? []

		sites.push({
			// Ripgrep prefixes each path with the search root, which is usually `./`.
			file: file.replace(/^\.\//, ""),
			line: Number(lineNumber),
			exported: text.startsWith("export "),
			text: text.trim(),
		})

		found.set(name, sites)
	}

	for (const [name, sites] of found) {
		found.set(
			name,
			sites.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
		)
	}

	return found
}

/**
 * Returns every declared function whose name contains `query`, ignoring case;
 * a query that is not a bare identifier fragment returns no results.
 */
export function searchDeclarations(
	query: string,
	{ cwd, searchPaths = ["."], binary = "rg" }: FindDeclarationsOptions
): SymbolFinding[] {
	if (!isIdentifier(query)) return []

	const output = runRipgrep(declarationPatterns(`\\w*${query}\\w*`), cwd, searchPaths, { ignoreCase: true, binary })
	const lowered = query.toLowerCase()
	const found = collectSites(output, (name) => name.toLowerCase().includes(lowered))

	return [...found].map(([name, sites]) => ({ name, sites })).toSorted((a, b) => a.name.localeCompare(b.name))
}

function runRipgrep(
	patterns: readonly string[],
	cwd: PathBuilderLike,
	searchPaths: readonly string[],
	{ ignoreCase = false, binary = "rg" }: { ignoreCase?: boolean; binary?: string } = {}
): string {
	const args = [
		"--line-number",
		"--no-heading",
		"--color",
		"never",
		// The `*.ts` glob excludes `.tsx` files, which ripgrep's `ts` type would include;
		// the exclusion globs come after it because a later glob wins.
		"--glob",
		"*.ts",
		"--glob",
		"!**/node_modules/**",
		"--glob",
		"!**/out/**",
		"--glob",
		"!**/scratchpad/**",
		...(ignoreCase ? ["--ignore-case"] : []),
		...patterns.flatMap((pattern) => ["-e", pattern]),
		...searchPaths,
	]

	try {
		return runFileSync(binary, args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
	} catch (error) {
		if ((error as { status?: number }).status === RIPGREP_NO_MATCH) return ""

		// A missing ripgrep must throw, because an empty result would claim the symbol has no declaration.
		if ((error as { code?: string }).code === "ENOENT") {
			throw new Error(`ripgrep (${binary}) is not on PATH, so the declaration search did not run.`)
		}

		throw error
	}
}

/**
 * A name to report, with its declaration sites.
 */
export interface SymbolFinding {
	name: string
	sites: DeclarationSite[]
}

/**
 * Options for {@link selectReportable}.
 */
export interface SelectReportableOptions {
	/**
	 * The repository-relative path of the file being written; its own declarations are ignored.
	 */
	writingFile: string
}

/**
 * Keeps only the names exported from some other file; generic local names such as `main`
 * or `run` are rarely exported, so this rule filters them without a stoplist.
 */
export function selectReportable(
	found: Map<string, DeclarationSite[]>,
	{ writingFile }: SelectReportableOptions
): SymbolFinding[] {
	const findings: SymbolFinding[] = []

	for (const [name, sites] of found) {
		const elsewhere = sites.filter((site) => site.file !== writingFile)

		if (!elsewhere.some((site) => site.exported)) continue

		findings.push({ name, sites: elsewhere })
	}

	return findings.toSorted((a, b) => a.name.localeCompare(b.name))
}

/**
 * The text a tool call is about to add and the file it targets.
 */
export interface WriteIntent {
	filePath: string
	source: string
}

function readStringField(input: Record<string, unknown>, key: string): string | null {
	const value = input[key]

	return typeof value === "string" && value.length ? value : null
}

/**
 * Returns the text a Write or Edit call is about to add, or `null` when there is none —
 * an Edit contributes only its replacement text, and an unrecognized payload returns `null`
 * rather than throwing because this runs in a hook.
 */
export function readWriteIntent(payload: unknown): WriteIntent | null {
	if (!payload || typeof payload !== "object") return null

	const { tool_name: toolName, tool_input: toolInput } = payload as Record<string, unknown>

	if (!toolInput || typeof toolInput !== "object") return null

	const input = toolInput as Record<string, unknown>
	const filePath = readStringField(input, "file_path")

	if (!filePath) return null

	const source = toolName === "Write" ? readStringField(input, "content") : null
	const edited = toolName === "Edit" ? readStringField(input, "new_string") : null
	const text = source ?? edited

	return text ? { filePath, source: text } : null
}

/**
 * Renders findings as a note for the author, with each site's signature and export status,
 * reporting matches without telling the author to reuse them because two functions
 * with the same name can differ in units or dependencies.
 */
export function formatFindings(findings: readonly SymbolFinding[], declaredNames: readonly string[] = []): string {
	if (!findings.length) return ""

	const declared = new Set(declaredNames)
	const containedIn = new Map<string, string>()

	for (const name of declaredNames) {
		for (const candidate of containedNameCandidates(name)) {
			containedIn.set(candidate.toLowerCase(), name)
		}
	}

	const lines = [
		"Existing declarations answer to what you are about to write — by the same name, or by a shorter name yours " +
			"spells out at greater length. The existing implementation may or may not be the one to reuse — check the " +
			"signature, and check what depending on its workspace would cost:",
	]

	for (const { name, sites } of findings) {
		const longer = declared.has(name) ? undefined : containedIn.get(name.toLowerCase())

		lines.push(`\n${name}${longer ? ` — the name inside your ${longer}` : ""}:`)

		for (const site of sites) {
			lines.push(`  ${site.file}:${site.line}  [${site.exported ? "exported" : "local"}]  ${site.text}`)
		}
	}

	return lines.join("\n")
}
