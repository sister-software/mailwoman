#!/usr/bin/env npx tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Promote LLM-synthesized golden-set candidates into a versioned golden dir, with
 *   human-typed-likelihood filters + dedup. Companion to `expand-golden.ts`.
 *
 *   ## What it does
 *
 *   1. Reads a candidates JSONL from `data/eval/golden/candidates/`
 *   2. Reads the previous-version golden dir for forward-copy + dedup base
 *   3. Applies filters that drop candidates unlikely to be human-typed:
 *
 *        - Components-glued-without-commas (5+ components but <2 separators → freeform jumble)
 *        - Postcode-at-start with many other components (US/UK conventions put postcode last; FR puts it
 *                 before locality only)
 *        - Suspicious-token signals (unmatched brackets, control chars, etc.)
 *   4. Dedupes by normalized raw (case-insensitive, whitespace-collapsed)
 *   5. Splits by country (US/FR/other) and writes `data/eval/golden/v<X.Y.Z>/{us,fr,other}.jsonl`
 *   6. Forward-copies the prior version's adversarial.jsonl + README as-is
 *   7. Writes MANIFEST.json with sha256 of each output file
 *
 *   ## Usage
 *
 *   ```sh
 *   npx tsx packages/corpus/scripts/promote-golden.ts \
 *   --input data/eval/golden/candidates/expand-20260518-162627.jsonl \
 *   --bump-to v0.1.1 \
 *   --prior v0.1.0
 * ```
 *
 *   ## Flags
 *
 *   - `--input <path>` — candidates JSONL (required)
 *   - `--bump-to <version>` — target golden version dir (required, e.g. `v0.1.1`)
 *   - `--prior <version>` — previous version to forward-copy + dedup against (default `v0.1.0`)
 *   - `--golden-root <path>` — golden dir root; default `data/eval/golden`
 *   - `--no-filters` — skip the human-typed-likelihood filters (keep everything that passed
 *       expand-golden's validator)
 *   - `--dry-run` — report what would be written but don't touch disk
 */

import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

///<reference types="node" />

// ── Types ──────────────────────────────────────────────────────────────────

interface GoldenEntry {
	raw: string
	components: Record<string, string>
	country: string
	source: string
	notes?: string
	seed_source_id?: string
	seed_source_adapter?: string
	dropped_components?: string[]
	provenance?: { provider: string; model: string }
}

interface PromoteStats {
	candidatesIn: number
	filteredOut: { glued: number; postcodeLeading: number; suspicious: number; duplicate: number; forwardDup: number }
	kept: number
	perCountry: Record<string, number>
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseCLI() {
	const { values } = parseArgs({
		options: {
			input: { type: "string" },
			"bump-to": { type: "string" },
			prior: { type: "string", default: "v0.1.0" },
			"golden-root": { type: "string", default: "data/eval/golden" },
			"no-filters": { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
		},
	})

	if (!values.input) throw new Error("--input is required")

	if (!values["bump-to"]) throw new Error("--bump-to is required (e.g. v0.1.1)")

	return {
		inputPath: values.input,
		bumpTo: values["bump-to"],
		prior: values.prior!,
		goldenRoot: values["golden-root"]!,
		applyFilters: !values["no-filters"],
		dryRun: values["dry-run"]!,
	}
}

// ── Filters ───────────────────────────────────────────────────────────────

function normalize(s: string): string {
	return s.toLowerCase().replace(/\s+/g, " ").trim()
}

/**
 * Heuristic: an address with 5+ components but fewer than 2 separators (commas/newlines/dashes) is most likely glued
 * together rather than human-typed.
 */
function isComponentsGlued(entry: GoldenEntry): boolean {
	const componentCount = Object.keys(entry.components).length

	if (componentCount < 5) return false
	const separators = (entry.raw.match(/[,\n;]/g) ?? []).length

	return separators < 2
}

/**
 * Heuristic: in US/UK conventions, postcode goes at the END of the address. If postcode appears in the first third of a
 * multi-component raw AND there are 4+ components, the LLM probably over-aggressively reordered. FR is exempt (postcode
 * often precedes locality there).
 */
function isPostcodeBadlyLeading(entry: GoldenEntry): boolean {
	if (Object.keys(entry.components).length < 4) return false

	if (entry.country === "FR" || entry.country === "France") return false
	const postcode = entry.components.postcode

	if (!postcode) return false
	const postcodeIdx = entry.raw.indexOf(postcode)

	if (postcodeIdx === -1) return false

	return postcodeIdx < entry.raw.length / 3
}

/**
 * Heuristic: catch-all for visually-bad outputs — unmatched brackets, control chars, suspicious punctuation that
 * suggests the LLM emitted markup instead of an address.
 */
function isSuspicious(entry: GoldenEntry): boolean {
	const raw = entry.raw

	// eslint-disable-next-line no-control-regex
	if (/[\x00-\x1f\x7f]/.test(raw)) return true
	const openBrackets = (raw.match(/[[({<]/g) ?? []).length
	const closeBrackets = (raw.match(/[\])}>]/g) ?? []).length

	if (openBrackets !== closeBrackets) return true

	if (raw.split('"').length > 3) return true

	// too many quote marks
	return false
}

// ── IO ─────────────────────────────────────────────────────────────────────

function readJsonl<T>(path: string): T[] {
	if (!existsSync(path)) return []

	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as T)
}

function writeJsonl(path: string, entries: object[]): void {
	const text = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "")
	writeFileSync(path, text)
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex")
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
	const opts = parseCLI()

	process.stderr.write(`reading candidates: ${opts.inputPath}\n`)
	const candidates = readJsonl<GoldenEntry>(opts.inputPath)
	process.stderr.write(`  ${candidates.length} candidates loaded\n`)

	// Forward-copy base: existing entries from the prior golden version go forward verbatim,
	// and we dedupe new candidates against them so v_new = v_old ∪ accepted_candidates.
	const priorDir = join(opts.goldenRoot, opts.prior)
	const priorEntries: { country: string; entries: GoldenEntry[] }[] = []
	const seenNormalized = new Set<string>()

	if (existsSync(priorDir)) {
		for (const f of readdirSync(priorDir).filter((n) => n.endsWith(".jsonl"))) {
			const country = f.replace(".jsonl", "").toUpperCase()
			const entries = readJsonl<GoldenEntry>(join(priorDir, f))
			priorEntries.push({ country, entries })

			for (const e of entries) {
				seenNormalized.add(normalize(e.raw))
			}
			process.stderr.write(`  prior ${country}: ${entries.length} entries (forward-copy base)\n`)
		}
	} else {
		process.stderr.write(`  ⚠ prior dir ${priorDir} not found — starting fresh\n`)
	}

	// Filter pass
	const stats: PromoteStats = {
		candidatesIn: candidates.length,
		filteredOut: { glued: 0, postcodeLeading: 0, suspicious: 0, duplicate: 0, forwardDup: 0 },
		kept: 0,
		perCountry: {},
	}
	const accepted: GoldenEntry[] = []
	const seenInBatch = new Set<string>()

	for (const cand of candidates) {
		const norm = normalize(cand.raw)

		// Dedup pass 1: against prior versioned golden
		if (seenNormalized.has(norm)) {
			stats.filteredOut.forwardDup++
			continue
		}

		// Dedup pass 2: against this batch
		if (seenInBatch.has(norm)) {
			stats.filteredOut.duplicate++
			continue
		}

		if (opts.applyFilters) {
			if (isComponentsGlued(cand)) {
				stats.filteredOut.glued++
				continue
			}

			if (isPostcodeBadlyLeading(cand)) {
				stats.filteredOut.postcodeLeading++
				continue
			}

			if (isSuspicious(cand)) {
				stats.filteredOut.suspicious++
				continue
			}
		}

		accepted.push(cand)
		seenInBatch.add(norm)
		stats.kept++
		const country = cand.country || "OTHER"
		stats.perCountry[country] = (stats.perCountry[country] ?? 0) + 1
	}

	// Bucket per country, including forward-copied entries
	const buckets = new Map<string, GoldenEntry[]>()

	for (const { country, entries } of priorEntries) {
		// Existing files keyed by filename uppercase (us.jsonl → US, adversarial.jsonl → ADVERSARIAL)
		buckets.set(country, [...entries])
	}

	for (const cand of accepted) {
		const key = (cand.country || "OTHER").toUpperCase()

		if (!buckets.has(key)) {
			buckets.set(key, [])
		}
		buckets.get(key)!.push(cand)
	}

	// Output
	const outDir = join(opts.goldenRoot, opts.bumpTo)
	process.stderr.write(`\n=== plan ===\n`)
	process.stderr.write(`output dir: ${outDir}${opts.dryRun ? " (dry-run)" : ""}\n`)

	for (const [key, entries] of buckets) {
		process.stderr.write(`  ${key.toLowerCase()}.jsonl: ${entries.length} entries\n`)
	}
	process.stderr.write(`\n=== filter stats ===\n`)
	process.stderr.write(`candidates in:        ${stats.candidatesIn}\n`)
	process.stderr.write(`  filtered (glued):           ${stats.filteredOut.glued}\n`)
	process.stderr.write(`  filtered (postcode-lead):   ${stats.filteredOut.postcodeLeading}\n`)
	process.stderr.write(`  filtered (suspicious):      ${stats.filteredOut.suspicious}\n`)
	process.stderr.write(`  filtered (dup-in-batch):    ${stats.filteredOut.duplicate}\n`)
	process.stderr.write(`  filtered (dup-vs-prior):    ${stats.filteredOut.forwardDup}\n`)
	process.stderr.write(`  kept:                       ${stats.kept}\n`)
	process.stderr.write(`per-country (kept):\n`)

	for (const [c, n] of Object.entries(stats.perCountry).sort((a, b) => b[1] - a[1])) {
		process.stderr.write(`  ${c}: ${n}\n`)
	}

	if (opts.dryRun) {
		process.stderr.write(`\n(dry-run: no files written)\n`)

		return
	}

	mkdirSync(outDir, { recursive: true })
	const manifest: {
		promoted_at: string
		from: string
		from_sha256: string
		files: Record<string, { entries: number; sha256: string }>
	} = {
		promoted_at: new Date().toISOString(),
		from: opts.inputPath,
		from_sha256: sha256(opts.inputPath),
		files: {},
	}

	for (const [key, entries] of buckets) {
		const filename = `${key.toLowerCase()}.jsonl`
		const path = join(outDir, filename)
		writeJsonl(path, entries)
		manifest.files[filename] = { entries: entries.length, sha256: sha256(path) }
	}

	// Forward-copy non-.jsonl files (README.md, etc.) from prior
	if (existsSync(priorDir)) {
		for (const f of readdirSync(priorDir).filter((n) => !n.endsWith(".jsonl"))) {
			copyFileSync(join(priorDir, f), join(outDir, f))
			process.stderr.write(`  forward-copied: ${f}\n`)
		}
	}

	writeFileSync(join(outDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n")
	process.stderr.write(`\n✓ promoted to ${outDir}\n`)
}

try {
	main()
} catch (err) {
	process.stderr.write(`fatal: ${(err as Error).message}\n`)
	process.exitCode = 1
}
