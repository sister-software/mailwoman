#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Enforce the acronym-casing convention on EXPORTED identifiers: an acronym is capitalized as a
 *   whole camelCase component (`parseJSON`, `POILookup`, `createWOFResolver`), never title-cased
 *   (`parseJson`, `PoiLookup`, `createWofResolver`).
 *
 *   WHY THIS EXISTS. AGENTS.md carried the convention plus the sentence "There's no lint rule for
 *   this (oxlint can't express it); it's reviewer discipline." A 2026-07-25 sweep drove one fixed
 *   list of acronyms (`Json|Jsonl|Us|Http|Api|Url`) to zero and recorded the win — and by
 *   2026-08-02 a DIFFERENT set had drifted in behind it: ten exported `PoiBoard*` against 250+
 *   `POI*` occurrences, twelve `Nz*` in a file that spells the same acronym `NZ_` twenty-four lines
 *   away, plus `NUTS*`, `Crf*`, `Gbt*`. A convention enforced only by review, swept only against a
 *   fixed list, regrows at every acronym not on the list. So the sweep became a check.
 *
 *   The shape is borrowed from VS Code's `.eslint-plugin-local` rules: the mechanism is generic and
 *   knows nothing about this project, and ALL the domain knowledge lives in {@link ACRONYMS} and
 *   {@link ALLOWED} below. Adding an acronym is a one-line edit, not a code change.
 *
 *   Usage: `node scripts/lint-acronym-casing.ts` (runs inside `yarn lint`, so CI gates on it).
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

/**
 * The house form of every acronym we enforce. Listed in the ALL-CAPS spelling identifiers should use; the check derives
 * the title-case form (`POI` → `Poi`) and flags that.
 *
 * Only add an acronym once the repo has settled on its capitalized form — this check reports drift from an established
 * convention, it does not invent one.
 *
 * A hand-maintained list only ever contains the acronyms someone thought to add, which is its structural weakness:
 * `HTML`, `SVG`, `XML` and `ASCII` were all missing until the oxlint plugin's generic default list found `outHtml`
 * sitting in three sibling files. Prefer widening this list over trusting it.
 */
const ACRONYMS = [
	"API",
	// oxlint-disable-next-line unicorn/text-encoding-identifier-case -- an acronym in a policy list, not an encoding argument.
	"ASCII",
	"BIO",
	"CLI",
	"CRF",
	"CSV",
	"DMS",
	"FST",
	"GBT",
	"GERS",
	"HTML",
	"HTTP",
	"HTTPS",
	"ID",
	"JSON",
	"JSONL",
	"MCP",
	"MGRS",
	"NUTS",
	"NZ",
	"ONNX",
	"OSM",
	"POI",
	"SQL",
	"SVG",
	"TSV",
	"URI",
	"URL",
	"UTC",
	"WOF",
	"XML",
	"ZCTA",
] as const

/**
 * Identifiers exempt from the check, and why. Three categories are legitimate:
 *
 * 1. **External library names** — match the dependency's own casing (`HttpStatusCode` from axios, `SqliteDialect`
 *    following kysely's `SqliteAdapter` naming).
 * 2. **Pastel/Ink CLI flag props** — the framework derives a lowercase-acronym prop from a kebab flag (`--resolve-db` →
 *    `resolveDb`), so those schema keys must match its derivation.
 * 3. **Wire/DB contracts** — `snake_case` keys are string contracts and never camelCase by construction; the walker
 *    already skips string literals, so nothing is needed here for them.
 */
const ALLOWED = new Set<string>([
	// kysely's own dialect classes are `SqliteAdapter` / `SqliteDialect` / `SqliteDriver`; ours
	// implement its interfaces and read as a matched pair only if they follow suit.
	"SqliteAdapter",
	"SqliteDialect",
	"SqliteDialectConfig",
	"SqliteDriver",
	// `LedgerAppendOptions` receives the Pastel command's option bag verbatim — its fields ARE the
	// `--run-id` flag names, reconstructed as such a few lines below. The house form is derived at
	// the boundary (`const runID = options.runId!`).
	"runId",
])

/**
 * Drifted identifiers that are PUBLIC exports of published packages, waiting on a major to rename.
 *
 * Empty, and the check is stricter for it: with nothing deferred, every violation this reports is one a contributor can
 * fix in the commit that introduced it. Add an entry only for an export that PREDATES this check — a fresh violation
 * gets renamed, not recorded.
 */
const DEFERRED = new Map<string, string>()

/**
 * Files the check never reads. Dated historical records are point-in-time documents — AGENTS.md is explicit that eval
 * reports, reviews, postmortems and phase docs keep the acronyms they shipped with.
 */
const SKIP_PATH = /^(?:data|docs\/articles\/evals|docs\/superpowers|reviews)\//

/**
 * Matches an `export` of a named declaration and captures the name — the public surface, which is where a wrong acronym
 * costs a consumer a breaking rename later. Local identifiers are out of scope on purpose: renaming those is free at
 * any time and flagging them is noise.
 */
const EXPORTED_DECLARATION =
	/^export\s+(?:async\s+)?(?:abstract\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/

/**
 * A member of an exported interface / type literal / class — ` fooBar?: T`, ` fooBar(): T`.
 *
 * Members are public surface too: a consumer constructing an options object types the property name. This repo shipped
 * seven title-cased acronyms on members (`semiCrfGrammar`, `loadOnnx`, `outJsonl`, …) while a declaration-only check
 * reported the tree clean, so the two patterns are both required. Indentation is the cheap proxy for "inside a block" —
 * good enough here, and the oxlint plugin that supersedes this script reads the real AST.
 */
const MEMBER_DECLARATION = /^\t+(?:readonly\s+)?([a-z_$][\w$]*)\??[(:]/

interface Violation {
	file: string
	line: number
	identifier: string
	found: string
	expected: string
}

/**
 * Title case of an acronym — the drifted spelling (`POI` → `Poi`, `NZ` → `Nz`).
 */
function titleCase(acronym: string): string {
	return acronym[0] + acronym.slice(1).toLowerCase()
}

/**
 * Is `found` a whole camelCase component of `identifier` at `index`?
 *
 * This is the entire subtlety of the check. `Poi` appears inside `Point`, `Id` inside `Identifier`, `Us` inside `User`
 * — none of those are acronyms, they are prefixes of ordinary words. A component boundary means the run ENDS where the
 * next character is uppercase, a digit, `_`, or end of identifier. `PoiBoard` qualifies (`B` follows); `Point` does not
 * (`n` follows).
 */
function isWholeComponent(identifier: string, index: number, found: string): boolean {
	const after = identifier[index + found.length]

	if (after !== undefined && !/[A-Z0-9_]/.test(after)) return false

	const before = identifier[index - 1]

	return before === undefined || /[a-z0-9_]/.test(before)
}

function scan(file: string): Violation[] {
	const out: Violation[] = []
	const lines = readFileSync(file, "utf8").split("\n")

	// Members only count inside an EXPORTED block — a private interface's property names are local.
	let inExportedBlock = false

	for (const [i, line] of lines.entries()) {
		// Only TYPE blocks contribute members. A function body's destructuring pattern
		// (`const { baseUrl: baseURL } = config`) has the same shape as a property signature, and the
		// left half of a rename is the SOURCE object's key — someone else's name, never ours.
		if (/^export\s+(?:abstract\s+)?(?:interface|type|class)\b/.test(line)) {
			inExportedBlock = /[{]\s*$/.test(line)
		} else if (/^export\s/.test(line) || line.startsWith("}")) {
			inExportedBlock = false
		}

		const declaration = EXPORTED_DECLARATION.exec(line) ?? (inExportedBlock ? MEMBER_DECLARATION.exec(line) : null)

		if (!declaration) continue
		const identifier = declaration[1]!

		if (ALLOWED.has(identifier)) continue

		// Collect EVERY drifted component, scanning every occurrence of each acronym.
		//
		// Two traps here, both of which a first-match-and-stop loop walks into. Scanning only the
		// first occurrence misses the real one whenever an earlier occurrence is a false positive:
		// in `PointPoiBoard` the `Poi` inside `Point` fails the component test, and giving up there
		// leaves the genuine `PoiBoard` unreported. Stopping after the first ACRONYM is the same
		// mistake one level up: `parseJsonlThenJson` would report `Jsonl` and suggest a fix that
		// leaves `Json` behind.
		const hits: Array<{ index: number; found: string; acronym: string }> = []

		for (const acronym of ACRONYMS) {
			const found = titleCase(acronym)

			for (let index = identifier.indexOf(found); index !== -1; index = identifier.indexOf(found, index + 1)) {
				if (isWholeComponent(identifier, index, found)) hits.push({ index, found, acronym })
			}
		}

		if (!hits.length) continue

		// Rewrite right-to-left so each splice keeps the earlier indices valid, and drop any hit
		// nested inside one already taken (`JSON` inside `JSONL`) — longest wins at a given start.
		const ordered = hits.toSorted((a, b) => b.index - a.index || b.found.length - a.found.length)
		let expected = identifier
		let lastStart = Number.POSITIVE_INFINITY

		for (const hit of ordered) {
			if (hit.index + hit.found.length > lastStart) continue
			expected = expected.slice(0, hit.index) + hit.acronym + expected.slice(hit.index + hit.found.length)
			lastStart = hit.index
		}

		out.push({
			file,
			line: i + 1,
			identifier,
			found: [...new Set(ordered.map((h) => h.found))].toReversed().join(", "),
			expected,
		})
	}

	return out
}

const files = execFileSync("git", ["ls-files", "*.ts", "*.tsx"], { encoding: "utf8" })
	.split("\n")
	.filter(Boolean)
	.filter((file) => !SKIP_PATH.test(file))

const found = files.flatMap(scan)
const deferred = found.filter((v) => DEFERRED.has(v.identifier))
const violations = found.filter((v) => !DEFERRED.has(v.identifier))

if (deferred.length) {
	console.warn(`Acronym casing: ${deferred.length} deferred rename(s) owed at the next major.\n`)

	for (const v of deferred) {
		console.warn(`  ${v.file}:${v.line}  ${v.identifier}  →  ${v.expected}   (${DEFERRED.get(v.identifier)})`)
	}

	console.warn("")
}

if (violations.length) {
	console.error(`Acronym casing: ${violations.length} exported identifier(s) title-case an acronym.\n`)

	for (const v of violations) {
		console.error(`  ${v.file}:${v.line}  ${v.identifier}  →  ${v.expected}`)
	}

	console.error(
		"\nAn acronym is capitalized as a whole camelCase component (see AGENTS.md).\n" +
			"If this is an external library's own spelling, add it to ALLOWED in scripts/lint-acronym-casing.ts with a\n" +
			"comment saying whose spelling it follows. If it is a PUBLIC export whose rename must wait for a major,\n" +
			"rename it anyway — DEFERRED is for identifiers that predate this check, not a place to put new ones."
	)

	process.exit(1)
}

console.log(`Acronym casing: ${files.length} files clean (${deferred.length} deferred).`)
