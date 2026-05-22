#!/usr/bin/env npx tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate golden-set candidate entries by LLM-driven surface-form synthesis from a verified-label
 *   seed pulled out of the corpus's labeled test split.
 *
 *   ## Why this approach
 *
 *   The Phase 2 golden set has 74 entries; session-notes.md called for ≥500/locale. Manual curation
 *   doesn't scale. Pure-LLM generation (invent raw + labels from scratch) is too noisy — labels
 *   would be unverified.
 *
 *   This script takes the middle path:
 *
 *   1. **Seeds come from corpus-v0.2.0 test shard** — already through the alignment pipeline, so labels
 *        are pipeline-verified.
 *   2. **LLM only varies the surface form** — case, abbreviations, reordering, dropped components. The
 *        component VALUES (locality string, postcode digits, etc.) are preserved verbatim.
 *   3. **Programmatic validator drops hallucinations** — every component value must appear as a
 *        substring (case-insensitive, whitespace-normalized) of the variant's raw. Failures dropped
 *        silently; cost is wasted tokens, never bad-labeled golden entries.
 *
 *   ## Usage
 *
 *   ```sh
 *   DEEPSEEK_API_KEY=sk-... \
 *   npx tsx packages/corpus/scripts/expand-golden.ts \
 *   --count 1000 \
 *   --variants 5 \
 *   --output data/eval/golden/candidates/expand-$(date +%Y%m%d-%H%M%S).jsonl
 * ```
 *
 *   ## Flags
 *
 *   - `--corpus <path>` — corpus test shard glob; default
 *       `/mnt/playpen/mailwoman-data/corpus/versioned/v0.2.0/corpus-v0.2.0/test/*.parquet`
 *   - `--count <n>` — total seeds to process; default `100` (pilot)
 *   - `--variants <n>` — variants requested per seed; default `5`
 *   - `--output <path>` — JSONL output; default `data/eval/golden/candidates/expand-<ts>.jsonl`
 *   - `--provider deepseek|anthropic` — LLM provider; default `deepseek`
 *   - `--model <name>` — model id; default depends on provider
 *   - `--concurrency <n>` — parallel LLM calls; default `4`
 *
 *   ## Env
 *
 *   - `DEEPSEEK_API_KEY` — required for `--provider deepseek`
 *   - `ANTHROPIC_API_KEY` — required for `--provider anthropic`
 *
 *   ## What this script does NOT do
 *
 *   - Does not commit anything or modify the versioned golden dir. Candidates land in
 *       `data/eval/golden/candidates/` for operator review (skim, prune, then run
 *       `promote-golden.ts`).
 *   - Does not score the LLM's quality — that's an eyeball job after pilot lands.
 *   - Does not retry hallucinated candidates. Cost of wasted tokens is trivial (~$0.0006/each).
 */

///<reference types="node" />

import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { parseArgs } from "node:util"

import { ParquetReader } from "@dsnp/parquetjs"

// ── Types ─────────────────────────────────────────────────────────────────

interface CorpusRow {
	raw: string
	tokens: string[]
	labels: string[]
	country: string
	source: string
	source_id: string
	license: string
}

interface Seed {
	raw: string
	components: Record<string, string>
	country: string
	source: string
	source_id: string
}

interface Candidate {
	raw: string
	dropped?: string[]
}

interface GoldenCandidate {
	raw: string
	components: Record<string, string>
	country: string
	source: string
	seed_source_id: string
	seed_source_adapter: string
	dropped_components: string[]
	provenance: { provider: string; model: string }
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseCli() {
	const { values } = parseArgs({
		options: {
			corpus: {
				type: "string",
				default: "/mnt/playpen/mailwoman-data/corpus/versioned/v0.2.0/corpus-v0.2.0/test/part-0000.parquet",
			},
			count: { type: "string", default: "100" },
			variants: { type: "string", default: "5" },
			output: { type: "string" },
			provider: { type: "string", default: "deepseek" },
			model: { type: "string" },
			concurrency: { type: "string", default: "4" },
			"include-sources": { type: "string" },
		},
	})
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
	return {
		corpusPath: values.corpus!,
		count: Number.parseInt(values.count!, 10),
		variants: Number.parseInt(values.variants!, 10),
		outputPath: values.output ?? `data/eval/golden/candidates/expand-${ts}.jsonl`,
		provider: values.provider! as "deepseek" | "anthropic",
		model: values.model ?? (values.provider === "anthropic" ? "claude-haiku-4-5-20251001" : "deepseek-chat"),
		concurrency: Number.parseInt(values.concurrency!, 10),
		includeSources: values["include-sources"]
			? new Set(values["include-sources"].split(",").map((s) => s.trim()))
			: null,
	}
}

// ── Seed loading ──────────────────────────────────────────────────────────

/**
 * Decode BIO labels + tokens into a verified components map. Mirrors the Python `decode_components`
 * in mailwoman_train/eval.py — first-occurrence-wins per tag, contiguous B-X/I-X runs concatenated
 * with a single space (the canonical separator used by corpus alignment).
 */
function decodeComponents(tokens: string[], labels: string[]): Record<string, string> {
	const out: Record<string, string> = {}
	let currentTag: string | null = null
	let currentTokens: string[] = []
	const flush = () => {
		if (currentTag && currentTokens.length > 0 && !(currentTag in out)) {
			out[currentTag] = currentTokens.join(" ").trim()
		}
		currentTag = null
		currentTokens = []
	}
	for (let i = 0; i < labels.length; i++) {
		const label = labels[i]!
		const tok = tokens[i] ?? ""
		if (label === "O") {
			flush()
			continue
		}
		const [prefix, tag] = label.split("-", 2)
		if (prefix === "B" || currentTag !== tag) {
			flush()
			currentTag = tag!
			currentTokens = [tok]
		} else {
			currentTokens.push(tok)
		}
	}
	flush()
	return out
}

async function loadSeeds(corpusPath: string, count: number, includeSources: Set<string> | null): Promise<Seed[]> {
	const paths = corpusPath
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean)
	process.stderr.write(`reading seeds from ${paths.length} shard(s) (target: ${count}, stratified)\n`)
	if (includeSources) {
		process.stderr.write(`  include-sources filter: ${Array.from(includeSources).join(", ")}\n`)
	}

	// Stratified sampling: read all rows from all shards, group by source. Bounded by per-source
	// reservoir: keep at most max(2*count, 5000) rows per source so we don't blow memory on train
	// shards (1M rows × many shards). Sampling later is uniform within each pool.
	const bySource = new Map<string, Seed[]>()
	const PER_SOURCE_CAP = Math.max(2 * count, 5000)
	let scanned = 0
	let skippedThinComponents = 0

	for (const path of paths) {
		const reader = await ParquetReader.openFile(path)
		const cursor = reader.getCursor()
		while (true) {
			const row = (await cursor.next()) as CorpusRow | null
			if (!row) break
			scanned++
			// Source allow-list (CLI --include-sources) — applied early to skip parsing rows we won't use
			if (includeSources && !includeSources.has(row.source)) continue
			const components = decodeComponents(row.tokens ?? [], row.labels ?? [])
			// Skip rows with too few components — single-name wof-admin entries don't make useful seeds
			if (Object.keys(components).length < 2) {
				skippedThinComponents++
				continue
			}
			const seed: Seed = {
				raw: row.raw,
				components,
				country: row.country,
				source: row.source,
				source_id: row.source_id,
			}
			let bucket = bySource.get(row.source)
			if (!bucket) {
				bucket = []
				bySource.set(row.source, bucket)
			}
			if (bucket.length < PER_SOURCE_CAP) bucket.push(seed)
		}
		await reader.close()
	}

	process.stderr.write(
		`  scanned ${scanned} rows across ${paths.length} shard(s); thin-components dropped: ${skippedThinComponents}\n`
	)
	process.stderr.write(`  per-source pool sizes:\n`)
	for (const [src, pool] of bySource) process.stderr.write(`    ${src}: ${pool.length}\n`)

	// Round-robin sample. Each source gives floor(count / nSources) seeds; rounding goes
	// to sources in alphabetical order. If a pool is smaller than its target, take all of it.
	const sources = Array.from(bySource.keys()).sort()
	const perSource = Math.floor(count / sources.length)
	const remainder = count - perSource * sources.length
	const picked: Seed[] = []
	for (let i = 0; i < sources.length; i++) {
		const src = sources[i]!
		const pool = bySource.get(src)!
		const target = perSource + (i < remainder ? 1 : 0)
		// Random subsample without replacement — deterministic via shuffle then slice
		for (let j = pool.length - 1; j > 0; j--) {
			const k = Math.floor(Math.random() * (j + 1))
			;[pool[j], pool[k]] = [pool[k]!, pool[j]!]
		}
		const take = Math.min(target, pool.length)
		picked.push(...pool.slice(0, take))
		if (take < target) {
			process.stderr.write(`    ⚠ ${src}: requested ${target}, pool had ${pool.length}\n`)
		}
	}
	process.stderr.write(`  → loaded ${picked.length} seeds across ${sources.length} sources\n`)
	return picked
}

// ── LLM providers ─────────────────────────────────────────────────────────

interface LlmProvider {
	name: string
	model: string
	generateVariants(seed: Seed, n: number): Promise<Candidate[]>
}

const SYSTEM_PROMPT = `You are a postal-address surface-form generator. Given a structured address, produce realistic variants a human might type into a geocoder.

CONSTRAINT — you MUST preserve every kept component value verbatim in the output. You may:
- vary case (UPPER, lower, Title Case)
- abbreviate (Saint → St, Avenue → Ave, Boulevard → Blvd, North → N, etc.)
- vary punctuation (commas, dashes, spaces, line breaks)
- reorder components (postcode-first, country-first, address-only)
- drop OPTIONAL components — list them in "dropped"

OPTIONAL components (allowed to drop): country, postcode, dependent_locality, subregion, cedex.
REQUIRED components (must keep, even if input has them): locality, region (when present),
street, house_number, venue (when present).

ALWAYS keep AT LEAST 2 components in the final raw text. Single-component variants like
"VT" or "Paris" are USELESS as eval entries — do not produce them.

You MUST NOT:
- introduce typos (validator drops these silently — wasted tokens)
- invent new component values
- produce text longer than 500 characters
- output a degenerate single-token answer

OUTPUT a JSON array of N objects, each shaped {"raw": "...", "dropped": ["..."]}.`

function buildUserPrompt(seed: Seed, n: number): string {
	return `INPUT:
${JSON.stringify({ raw: seed.raw, components: seed.components, country: seed.country }, null, 2)}

N: ${n}`
}

function makeDeepseekProvider(model: string): LlmProvider {
	const apiKey = process.env.DEEPSEEK_API_KEY
	if (!apiKey) throw new Error("DEEPSEEK_API_KEY env var is required for --provider deepseek")
	return {
		name: "deepseek",
		model,
		async generateVariants(seed, n) {
			const res = await fetch("https://api.deepseek.com/chat/completions", {
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					model,
					messages: [
						{ role: "system", content: SYSTEM_PROMPT },
						{ role: "user", content: buildUserPrompt(seed, n) },
					],
					response_format: { type: "json_object" },
					max_tokens: 800,
					temperature: 0.7,
				}),
				signal: AbortSignal.timeout(60_000),
			})
			if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${await res.text()}`)
			const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> }
			const content = data.choices?.[0]?.message.content ?? "{}"
			return parseCandidates(content)
		},
	}
}

function makeAnthropicProvider(model: string): LlmProvider {
	const apiKey = process.env.ANTHROPIC_API_KEY
	if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var is required for --provider anthropic")
	return {
		name: "anthropic",
		model,
		async generateVariants(seed, n) {
			const res = await fetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: {
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					max_tokens: 800,
					system: SYSTEM_PROMPT,
					messages: [{ role: "user", content: buildUserPrompt(seed, n) }],
				}),
				signal: AbortSignal.timeout(60_000),
			})
			if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`)
			const data = (await res.json()) as { content?: Array<{ type: string; text: string }> }
			const text = data.content?.find((c) => c.type === "text")?.text ?? "[]"
			return parseCandidates(text)
		},
	}
}

function parseCandidates(text: string): Candidate[] {
	// Strip markdown fences the model sometimes wraps around JSON
	const cleaned = text.replace(/^```(?:json)?\n?|\n?```$/g, "").trim()
	try {
		const parsed = JSON.parse(cleaned) as unknown
		if (Array.isArray(parsed)) return parsed as Candidate[]
		// Some providers wrap in {"variants": [...]} or {"candidates": [...]}
		if (typeof parsed === "object" && parsed !== null) {
			for (const key of ["variants", "candidates", "results"]) {
				const v = (parsed as Record<string, unknown>)[key]
				if (Array.isArray(v)) return v as Candidate[]
			}
		}
	} catch {
		// fall through
	}
	return []
}

// ── Validator ─────────────────────────────────────────────────────────────

function normalize(s: string): string {
	return s.toLowerCase().replace(/\s+/g, " ").trim()
}

// Components that are NEVER allowed to be dropped — keeps degenerate single-token candidates out.
const REQUIRED_COMPONENT_TAGS = new Set(["locality", "region", "street", "house_number", "venue"])

function validate(seed: Seed, candidate: Candidate): boolean {
	if (!candidate.raw || typeof candidate.raw !== "string") return false
	if (candidate.raw.length > 500) return false
	if (/```|<\/?\w+>|^\s*\{/.test(candidate.raw)) return false
	const normRaw = normalize(candidate.raw)
	const dropped = new Set(candidate.dropped ?? [])

	// LLM cannot drop required components present in the seed.
	for (const tag of dropped) {
		if (REQUIRED_COMPONENT_TAGS.has(tag) && seed.components[tag]) return false
	}

	// Every kept component value must appear verbatim (post-normalization) in the candidate raw.
	let keptCount = 0
	for (const [tag, value] of Object.entries(seed.components)) {
		if (dropped.has(tag)) continue
		if (!value) continue
		if (!normRaw.includes(normalize(value))) return false
		keptCount++
	}

	// Reject degenerate single-component candidates ("VT", "Paris" alone).
	if (keptCount < 2) return false

	return true
}

// ── Main pipeline ─────────────────────────────────────────────────────────

async function main() {
	const opts = parseCli()
	const provider = opts.provider === "anthropic" ? makeAnthropicProvider(opts.model) : makeDeepseekProvider(opts.model)
	process.stderr.write(`provider: ${provider.name}  model: ${provider.model}\n`)

	const seeds = await loadSeeds(opts.corpusPath, opts.count, opts.includeSources)
	if (seeds.length === 0) {
		process.stderr.write("no seeds loaded — corpus path or filter is wrong\n")
		process.exitCode = 2
		return
	}

	await mkdir(dirname(opts.outputPath), { recursive: true })
	const outLines: string[] = []
	let kept = 0
	let dropped = 0
	let errored = 0

	// Bounded-concurrency worker pool
	let cursor = 0
	const workers = Array.from({ length: Math.min(opts.concurrency, seeds.length) }, async () => {
		while (true) {
			const i = cursor++
			if (i >= seeds.length) return
			const seed = seeds[i]!
			try {
				const candidates = await provider.generateVariants(seed, opts.variants)
				for (const cand of candidates) {
					if (validate(seed, cand)) {
						const goldenCandidate: GoldenCandidate = {
							raw: cand.raw,
							components: { ...seed.components },
							country: seed.country,
							source: `expand-golden:${provider.name}`,
							seed_source_id: seed.source_id,
							seed_source_adapter: seed.source,
							dropped_components: cand.dropped ?? [],
							provenance: { provider: provider.name, model: provider.model },
						}
						// Remove dropped components from the components map
						for (const tag of goldenCandidate.dropped_components) delete goldenCandidate.components[tag]
						outLines.push(JSON.stringify(goldenCandidate))
						kept++
					} else {
						dropped++
					}
				}
			} catch (err) {
				errored++
				process.stderr.write(`  ✗ seed ${seed.source_id}: ${(err as Error).message}\n`)
			}
			if ((i + 1) % 10 === 0) {
				process.stderr.write(
					`  progress: ${i + 1}/${seeds.length}  kept=${kept}  dropped=${dropped}  errored=${errored}\n`
				)
			}
		}
	})
	await Promise.all(workers)

	await writeFile(opts.outputPath, outLines.join("\n") + (outLines.length ? "\n" : ""))
	process.stderr.write(`\n=== summary ===\n`)
	process.stderr.write(`seeds processed:  ${seeds.length}\n`)
	process.stderr.write(`candidates kept:  ${kept}\n`)
	process.stderr.write(`candidates dropped (validator): ${dropped}\n`)
	process.stderr.write(`seeds with errors: ${errored}\n`)
	process.stderr.write(
		`yield: ${seeds.length > 0 ? ((kept / (seeds.length * opts.variants)) * 100).toFixed(1) : "0"}%\n`
	)
	process.stderr.write(`output:           ${opts.outputPath}\n`)
}

main().catch((err: Error) => {
	process.stderr.write(`fatal: ${err.message}\n${err.stack}\n`)
	process.exitCode = 1
})
