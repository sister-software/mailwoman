/**
 * Perturb-golden.ts — corpus-perturbation neutral-arena generator (Direction A).
 *
 * Our 376-assertion suite is a Pelias/addressit port (v0's lineage), so it can't reveal where
 * neural beats rules. This builds an UNBIASED arena from ground truth WE OWN: take golden v0.1.2
 * (already labeled in our schema) and apply rule- defeating perturbations while keeping the
 * component labels intact. Rule-based parsers lean on delimiters / capitalization / canonical
 * spacing; a contextual neural model should degrade more gracefully. The three-bucket harness then
 * shows whether that's true (the methodology-vindication test).
 *
 * Perturbation classes (each preserves the expected components — only the surface changes, and the
 * harness matcher normalizes case + allows substring):
 *
 * - Delimiter-strip : remove commas (rules depend on them)
 * - Lowercase : drop capitalization cues
 * - Glue : collapse the space between region and postcode ("OR97214")
 *
 * Run: node --experimental-strip-types scripts/eval/perturb-golden.ts\
 * --golden data/eval/golden/v0.1.2 --out /tmp/perturb-eval/perturbed.jsonl [--per-file 60] Then run
 * it through harness-v0-neural with --symmetric-match (see that flag).
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const GOLDEN = arg("golden", "data/eval/golden/v0.1.2")
const OUT = arg("out", "/tmp/perturb-eval/perturbed.jsonl")
const PER_FILE = Number(arg("per-file", "60"))

interface GoldenRow {
	raw: string
	components: Record<string, string>
	country?: string
	locale?: string
}

/** Collapse the space between a trailing region + postcode, e.g. "OR 97214" → "OR97214". */
function glue(raw: string): string {
	return raw.replace(/\b([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/g, "$1$2")
}

const PERTURBATIONS: Array<{ name: string; apply: (raw: string) => string }> = [
	{ name: "delimiter-strip", apply: (r) => r.replace(/,/g, "") },
	{ name: "lowercase", apply: (r) => r.toLowerCase() },
	{ name: "glue", apply: glue },
]

function main(): void {
	mkdirSync(dirname(OUT), { recursive: true })
	const out: string[] = []
	let base = 0

	for (const file of readdirSync(GOLDEN).filter((f) => f.endsWith(".jsonl"))) {
		const lines = readFileSync(join(GOLDEN, file), "utf8")
			.split("\n")
			.filter((l) => l.trim())
		// Deterministic spread: every Nth row up to PER_FILE.
		const step = Math.max(1, Math.floor(lines.length / PER_FILE))
		for (let i = 0; i < lines.length && out.length / PERTURBATIONS.length < base + PER_FILE; i += step) {
			let row: GoldenRow
			try {
				row = JSON.parse(lines[i]!)
			} catch {
				continue
			}
			if (!row.raw || !row.components) continue
			// Expected = the golden components, wrapped as {tag: [value]} (harness format).
			const expected: Record<string, string[]> = {}
			for (const [tag, val] of Object.entries(row.components)) if (val) expected[tag] = [val]
			if (Object.keys(expected).length === 0) continue

			for (const p of PERTURBATIONS) {
				const input = p.apply(row.raw)
				if (input === row.raw && p.name !== "lowercase") continue // perturbation was a no-op (skip; keep lowercase always)
				out.push(
					JSON.stringify({
						input,
						locale: row.locale ?? (row.country === "FR" ? "fr-FR" : "en-US"),
						expected,
						perturb_class: p.name,
						source: `perturb/${file}`,
					})
				)
			}
		}
		base += PER_FILE
	}

	writeFileSync(OUT, out.join("\n") + "\n")
	console.log(`wrote ${out.length} perturbed cases (${PERTURBATIONS.map((p) => p.name).join(", ")}) → ${OUT}`)
}

main()
