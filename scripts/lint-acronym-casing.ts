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
 */
const ACRONYMS = [
	"API",
	"BIO",
	"CLI",
	"CRF",
	"CSV",
	"DMS",
	"FST",
	"GBT",
	"GERS",
	"HTTP",
	"HTTPS",
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
	"TSV",
	"URI",
	"URL",
	"UTC",
	"WOF",
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

	for (const [i, line] of lines.entries()) {
		const declaration = EXPORTED_DECLARATION.exec(line)

		if (!declaration) continue
		const identifier = declaration[1]!

		for (const acronym of ACRONYMS) {
			const found = titleCase(acronym)
			const index = identifier.indexOf(found)

			if (index === -1) continue

			if (!isWholeComponent(identifier, index, found)) continue

			if (ALLOWED.has(identifier)) continue

			out.push({
				file,
				line: i + 1,
				identifier,
				found,
				expected: identifier.slice(0, index) + acronym + identifier.slice(index + found.length),
			})

			break
		}
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
