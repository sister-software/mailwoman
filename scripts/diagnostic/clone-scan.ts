#!/usr/bin/env node
/**
 * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
 *
 *   Clone scan — the instrument behind `docs/superpowers/specs/2026-08-02-taste-audit-findings.md`.
 *   Extracts every function body by brace-matching, strips comments, collapses whitespace, replaces
 *   the declared name with a placeholder (so renamed copies still collide), hashes, and reports the
 *   bodies that appear in more than one file.
 *
 *   Deliberately crude — no parser, no import graph. It finds IDENTICAL normalized bodies only, so
 *   its counts are a floor: anything that drifted by a line is invisible to it. Bodies under 4 lines
 *   or 120 normalized characters are skipped.
 *
 *   It generates candidates for reading, never findings. Ten of the audit's candidates died on
 *   reading (documented adapters, deliberate variants, allowlisted raw SQL) — see the findings doc's
 *   rejected-candidates appendix before acting on any group this prints.
 *
 *   Usage: `node scripts/diagnostic/clone-scan.ts`
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

const files = execFileSync("git", ["ls-files", "*.ts", "*.tsx"], { encoding: "utf8" })
	.split("\n")
	.filter(Boolean)
	.filter((f) => !f.startsWith("data/") && !f.includes("/models/") && !f.includes("node_modules"))

interface Unit {
	file: string
	line: number
	name: string
	body: string
	lines: number
}

const DECL =
	/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]*)?=>)/

/**
 * Files larger than this are generated blobs (model JSON, `types.gen.ts`), not hand-written code. The largest
 * hand-written source in the repo is ~2,300 lines / ~90 KB, so this clears it by 10×.
 */
const MAX_FILE_BYTES = 900_000

/**
 * Brace-walk ceiling, in lines. Nothing hand-written that this scan cares about is longer, and it bounds the inner loop
 * on a pathological unclosed brace.
 */
const MAX_BODY_LINES = 400

/**
 * Bodies shorter than this are one-liners and wrappers — they collide constantly and say nothing.
 */
const MIN_BODY_LINES = 4

/**
 * Same idea in characters: a body this short after whitespace collapse carries no logic worth deduplicating. Tuned on
 * the 2026-08-02 sweep — below it the output is dominated by `return x.y`.
 */
const MIN_BODY_CHARS = 120

const units: Unit[] = []

for (const file of files) {
	let src: string

	try {
		src = readFileSync(file, "utf8")
	} catch {
		continue
	}

	if (src.length > MAX_FILE_BYTES) continue
	const lines = src.split("\n")

	for (let i = 0; i < lines.length; i++) {
		const m = DECL.exec(lines[i]!)

		if (!m) continue
		const name = m[1] ?? m[2]!

		// Walk braces from this line to find the body.
		let depth = 0
		let started = false
		let end = i

		for (let j = i; j < Math.min(lines.length, i + MAX_BODY_LINES); j++) {
			for (const ch of lines[j]!) {
				if (ch === "{") {
					depth++
					started = true
				} else if (ch === "}") {
					depth--
				}
			}

			if (started && depth <= 0) {
				end = j

				break
			}
		}

		const span = end - i + 1

		// Too small to be interesting.
		if (span < MIN_BODY_LINES) continue

		const body = lines
			.slice(i, end + 1)
			.join("\n")
			// normalize: drop comments, collapse whitespace, drop the declaration's own name
			.replaceAll(/\/\*[\s\S]*?\*\//g, "")
			.replaceAll(/\/\/[^\n]*/g, "")
			.replaceAll(/\s+/g, " ")
			.trim()

		if (body.length < MIN_BODY_CHARS) continue
		units.push({ file, line: i + 1, name, body, lines: span })
	}
}

const byHash = new Map<string, Unit[]>()

for (const u of units) {
	// Hash the body with the declared name stripped, so renamed copies still collide.
	const normalized = u.body.replaceAll(new RegExp(`\\b${u.name}\\b`, "g"), "FN")
	const h = createHash("sha1").update(normalized).digest("hex")
	const bucket = byHash.get(h)

	if (bucket) {
		bucket.push(u)
	} else {
		byHash.set(h, [u])
	}
}

const clones = [...byHash.values()]
	.filter((b) => b.length > 1)
	.filter((b) => new Set(b.map((u) => u.file)).size > 1)
	.toSorted((a, b) => b[0]!.lines * b.length - a[0]!.lines * a.length)

console.log(`scanned ${files.length} files, ${units.length} units, ${clones.length} cross-file clone groups\n`)

for (const group of clones) {
	const names = [...new Set(group.map((u) => u.name))].join(" / ")

	console.log(`## ${names}  (${group[0]!.lines} lines x ${group.length} copies)`)

	for (const u of group) {
		console.log(`   ${u.file}:${u.line}`)
	}

	console.log()
}
