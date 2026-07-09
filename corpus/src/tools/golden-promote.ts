/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Promote LLM-synthesized golden-set candidates into a versioned golden dir, with
 *   human-typed-likelihood filters + dedup. Companion to `golden-expand.ts`.
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
 *   mailwoman corpus golden promote \
 *   --input data/eval/golden/candidates/expand-20260518-162627.jsonl \
 *   --bump-to v0.1.1 \
 *   --prior v0.1.0
 *   ```
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { readJSONL, sha256File, writeJSONL } from "@mailwoman/core/utils"

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

export interface PromoteStats {
	candidatesIn: number
	filteredOut: { glued: number; postcodeLeading: number; suspicious: number; duplicate: number; forwardDup: number }
	kept: number
	perCountry: Record<string, number>
}

export interface PromoteGoldenOptions {
	/** Candidates JSONL (required). */
	input: string
	/** Target golden version dir (required, e.g. `v0.1.1`). */
	bumpTo: string
	/** Previous version to forward-copy + dedup against. Default `v0.1.0`. */
	prior?: string
	/** Golden dir root. Default `data/eval/golden`. */
	goldenRoot?: string
	/** Skip the human-typed-likelihood filters (keep everything that passed expand-golden's validator). */
	noFilters?: boolean
	/** Report what would be written but don't touch disk. */
	dryRun?: boolean
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

/** Read a JSONL, tolerating a missing file (returns `[]`) — prior golden dirs may lack a bucket. */
function readJSONLIfPresent<T>(path: string): T[] {
	if (!existsSync(path)) return []

	return readJSONL<T>(path)
}

// ── Main ───────────────────────────────────────────────────────────────────

export async function promoteGolden(
	options: PromoteGoldenOptions,
	report?: (line: string) => void
): Promise<PromoteStats> {
	const prior = options.prior ?? "v0.1.0"
	const goldenRoot = options.goldenRoot ?? "data/eval/golden"
	const applyFilters = !options.noFilters
	const dryRun = options.dryRun ?? false

	report?.(`reading candidates: ${options.input}`)
	const candidates = readJSONLIfPresent<GoldenEntry>(options.input)
	report?.(`  ${candidates.length} candidates loaded`)

	// Forward-copy base: existing entries from the prior golden version go forward verbatim,
	// and we dedupe new candidates against them so v_new = v_old ∪ accepted_candidates.
	const priorDir = join(goldenRoot, prior)
	const priorEntries: { country: string; entries: GoldenEntry[] }[] = []
	const seenNormalized = new Set<string>()

	if (existsSync(priorDir)) {
		for (const f of readdirSync(priorDir).filter((n) => n.endsWith(".jsonl"))) {
			const country = f.replace(".jsonl", "").toUpperCase()
			const entries = readJSONLIfPresent<GoldenEntry>(join(priorDir, f))
			priorEntries.push({ country, entries })

			for (const e of entries) {
				seenNormalized.add(normalize(e.raw))
			}
			report?.(`  prior ${country}: ${entries.length} entries (forward-copy base)`)
		}
	} else {
		report?.(`  ⚠ prior dir ${priorDir} not found — starting fresh`)
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

		if (applyFilters) {
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
	const outDir = join(goldenRoot, options.bumpTo)
	report?.(`=== plan ===`)
	report?.(`output dir: ${outDir}${dryRun ? " (dry-run)" : ""}`)

	for (const [key, entries] of buckets) {
		report?.(`  ${key.toLowerCase()}.jsonl: ${entries.length} entries`)
	}
	report?.(`=== filter stats ===`)
	report?.(`candidates in:        ${stats.candidatesIn}`)
	report?.(`  filtered (glued):           ${stats.filteredOut.glued}`)
	report?.(`  filtered (postcode-lead):   ${stats.filteredOut.postcodeLeading}`)
	report?.(`  filtered (suspicious):      ${stats.filteredOut.suspicious}`)
	report?.(`  filtered (dup-in-batch):    ${stats.filteredOut.duplicate}`)
	report?.(`  filtered (dup-vs-prior):    ${stats.filteredOut.forwardDup}`)
	report?.(`  kept:                       ${stats.kept}`)
	report?.(`per-country (kept):`)

	for (const [c, n] of Object.entries(stats.perCountry).sort((a, b) => b[1] - a[1])) {
		report?.(`  ${c}: ${n}`)
	}

	if (dryRun) {
		report?.(`(dry-run: no files written)`)

		return stats
	}

	mkdirSync(outDir, { recursive: true })
	const manifest: {
		promoted_at: string
		from: string
		from_sha256: string
		files: Record<string, { entries: number; sha256: string }>
	} = {
		promoted_at: new Date().toISOString(),
		from: options.input,
		from_sha256: await sha256File(options.input),
		files: {},
	}

	for (const [key, entries] of buckets) {
		const filename = `${key.toLowerCase()}.jsonl`
		const path = join(outDir, filename)
		writeJSONL(path, entries)
		manifest.files[filename] = { entries: entries.length, sha256: await sha256File(path) }
	}

	// Forward-copy non-.jsonl files (README.md, etc.) from prior
	if (existsSync(priorDir)) {
		for (const f of readdirSync(priorDir).filter((n) => !n.endsWith(".jsonl"))) {
			copyFileSync(join(priorDir, f), join(outDir, f))
			report?.(`  forward-copied: ${f}`)
		}
	}

	writeFileSync(join(outDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n")
	report?.(`✓ promoted to ${outDir}`)

	return stats
}
