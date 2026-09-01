import { runFileSync } from "@mailwoman/core/process"
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Does this symbol already have a home in the monorepo?
 */

/**
 * Both patterns anchor to column zero: indentation means a nested scope, and a symbol nobody outside the enclosing
 * function can reach is not a symbol anyone can reuse.
 */
const FUNCTION_PATTERN = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm

/**
 * A constant whose value is a function. The optional `(?::.*?)?` absorbs a type annotation, and it must be lazy so a
 * `const f: (a: number) => number = …` annotation surrenders the `=>` inside it and lets the real assignment match.
 *
 * Requiring the right-hand side to open with `function`, `(` or a type parameter is what keeps a duplicated LOOKUP
 * TABLE out of the results: a table is a different problem with a different answer, and reporting one buries the
 * duplicated logic this exists to surface.
 */
const FUNCTION_CONSTANT_PATTERN =
	/^(?:export\s+)?const\s+(\w+)\s*(?::.*?)?=\s*(?:async\s+)?(?:function\b|\(|<[A-Za-z])/gm

/**
 * Every top-level symbol a source blob declares that could carry reusable logic.
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
 * Where a name is already declared.
 */
export interface DeclarationSite {
	/**
	 * Repo-relative, so a result reads the same from any working directory.
	 */
	file: string
	line: number
	/**
	 * Only an exported declaration has a home a caller elsewhere could import.
	 */
	exported: boolean
	/**
	 * The declaration line itself — the signature is what decides whether the existing one fits.
	 */
	text: string
}

export interface FindDeclarationsOptions {
	cwd: string
	/**
	 * The ripgrep executable. Injectable so the missing-binary path is testable; nothing in production overrides it.
	 */
	binary?: string
	/**
	 * Trees to sweep. Defaults to the whole tree, which ripgrep already narrows by `.gitignore` and by TS file type.
	 */
	searchPaths?: readonly string[]
}

/**
 * `rg` exits 1 to mean "searched fine, matched nothing" — the common case here, not a failure.
 */
const RIPGREP_NO_MATCH = 1

/**
 * `path:line:text`, ripgrep's default line-oriented output.
 */
const OUTPUT_LINE_PATTERN = /^([^\n:]+):(\d+):(.*)$/gm

/**
 * A name that is not a bare identifier cannot be a declaration name, so dropping it costs nothing — and it means the
 * alternation below is built only from `\w+`, which needs no regex escaping.
 */
function isIdentifier(name: string): boolean {
	return /^\w+$/.test(name)
}

/**
 * Every top-level declaration of each name, across the tree.
 *
 * Names absent from the tree are absent from the map rather than present with an empty array: a caller iterating the
 * result should see only real findings, and `size` should read as the number of names that actually landed.
 */
export function findDeclarations(
	names: readonly string[],
	{ cwd, searchPaths = ["."], binary = "rg" }: FindDeclarationsOptions
): Map<string, DeclarationSite[]> {
	const found = new Map<string, DeclarationSite[]>()
	const searchable = names.filter(isIdentifier)

	if (!searchable.length) return found

	const alternation = searchable.join("|")
	const output = runRipgrep(declarationPatterns(`(?:${alternation})`), cwd, searchPaths, { binary })

	return collectSites(output, (name) => searchable.includes(name))
}

/**
 * The two declaration shapes, with `nameExpression` spliced in as the name to match. Callers supply either an
 * alternation of exact names or a substring expression; both are built from `\w`, which needs no regex escaping.
 */
function declarationPatterns(nameExpression: string): string[] {
	return [
		`^(?:export\\s+)?(?:async\\s+)?function\\s+${nameExpression}\\b`,
		`^(?:export\\s+)?const\\s+${nameExpression}\\s*(?::.*?)?=\\s*(?:async\\s+)?(?:function\\b|\\(|<[A-Za-z])`,
	]
}

/**
 * Group ripgrep's matching lines into sites, keeping only the names `accept` recognizes.
 *
 * Re-deriving the name from the matched line rather than from a capture group keeps one definition of what a
 * declaration is: whatever `extractDeclaredSymbols` reads, this reads.
 */
function collectSites(output: string, accept: (name: string) => boolean): Map<string, DeclarationSite[]> {
	const found = new Map<string, DeclarationSite[]>()

	for (const match of output.matchAll(OUTPUT_LINE_PATTERN)) {
		const [, file, lineNumber, text = ""] = match
		const name = extractDeclaredSymbols(text)[0]

		if (!file || !lineNumber || !name || !accept(name)) continue

		const sites = found.get(name) ?? []

		sites.push({
			// Ripgrep echoes the search path it was given, so a `.` root prefixes every hit.
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
 * Every declared symbol whose name contains `query`, case-insensitively.
 *
 * The query must be a bare identifier fragment. A fragment carrying regex metacharacters is refused rather than
 * escaped, which keeps every pattern in this module built from `\w` alone.
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
	cwd: string,
	searchPaths: readonly string[],
	{ ignoreCase = false, binary = "rg" }: { ignoreCase?: boolean; binary?: string } = {}
): string {
	const args = [
		"--line-number",
		"--no-heading",
		"--color",
		"never",
		// NOT `--type ts`: ripgrep's `ts` type covers `*.tsx` as well, and a React component is a different reuse
		// question with a different answer. Inclusion first, exclusions after — a later glob wins.
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

		// An unrunnable searcher must never be reported as an empty result: a caller reads "no sites" as "this symbol
		// has no home", and acts on it.
		if ((error as { code?: string }).code === "ENOENT") {
			throw new Error(`ripgrep (${binary}) is not on PATH, so the declaration search did not run.`)
		}

		throw error
	}
}

/**
 * A name worth telling the author about, with the sites that justify saying so.
 */
export interface SymbolFinding {
	name: string
	sites: DeclarationSite[]
}

export interface SelectReportableOptions {
	/**
	 * Repo-relative path of the file being written, so its own declarations cannot report themselves.
	 */
	writingFile: string
}

/**
 * Narrow raw declaration sites to the ones worth interrupting an author over.
 *
 * The rule is that a name must already be EXPORTED somewhere else. It is structural rather than a curated stoplist, and
 * that is the whole point: a stoplist has to be maintained, and the curated list of shared homes in `AGENTS.md` covers
 * a few dozen of several thousand exported names, which is how duplicates get written in the first place. Deriving the
 * rule from export status instead means the generic names — `main`, `run`, `visit`, `load` — fall out on their own,
 * because none of them is importable, while a name with a real home always survives.
 *
 * A name with no exported declaration is NOT necessarily fine. It may be a utility that deserves a home and does not
 * have one yet. Reporting those belongs to a census, not to a write-time hint, because there is nothing here for the
 * author to import.
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
 * The text an author is about to add, and where it is going.
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
 * The source text a tool call is about to introduce, or `null` when it introduces none.
 *
 * An `Edit` contributes only its replacement text. Scanning the whole file instead would report every declaration the
 * file already contains against itself, which is both wrong and the fastest way to make a hint worth ignoring.
 *
 * Every unrecognized shape answers `null` rather than throwing: this runs in front of the author's editor, and a hook
 * that throws on a payload it did not anticipate is a broken editor rather than a missing hint.
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
 * Render findings as the note an author reads before writing.
 *
 * It reports and does not prescribe, and the reason is on the page in `packages/api-kit/lib/metrics.ts`: that file's
 * `percentile` takes a FRACTION where `@mailwoman/core/stats` takes [0, 100], and its docstring explains that the
 * divergence is deliberate. Phrased as an instruction ("use the existing one"), this note would talk an author into
 * adding a workspace dependency and silently changing a unit. The signature and the export status are what settle the
 * question, so both travel with every site.
 */
export function formatFindings(findings: readonly SymbolFinding[]): string {
	if (!findings.length) return ""

	const lines = [
		"Existing declarations share a name with what you are about to write. The existing implementation may or may " +
			"not be the one to reuse — check the signature, and check what depending on its workspace would cost:",
	]

	for (const { name, sites } of findings) {
		lines.push(`\n${name}:`)

		for (const site of sites) {
			lines.push(`  ${site.file}:${site.line}  [${site.exported ? "exported" : "local"}]  ${site.text}`)
		}
	}

	return lines.join("\n")
}
