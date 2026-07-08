#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Label-correctness audit for the po_box/cedex coverage shard
 *   (scripts/build-po-box-cedex-shard.mjs). Independent of the builder's own rendering path: it
 *   re-derives every claim from the emitted JSONL and the codex matchers, so a builder bug can't
 *   vouch for itself.
 *
 *   Checks per row:
 *
 *   1. Tokens/labels parallel arrays + well-formed BIO (no orphan I-, no tag switch mid-run) —
 *        transitional, while both label representations ride the shard.
 *   2. RAW-SURFACE span check (#519): the row carries the char-offset span triple (parallel, sorted,
 *        in-bounds), and the po_box span's raw slice equals components.po_box VERBATIM —
 *        punctuation included ("P.O. Box 19" with the periods, the dotted blind spot the old
 *        token-stream comparison could not see) — same for cedex. Exactly one span per tag.
 *   3. Codex round-trip: every US po_box phrase with a codex-covered designator and a clean id must
 *        satisfy `isPOBox` (POB / PMB / "#" / noisy-id forms are corpus-template territory,
 *        exempt).
 *   4. Cedex spans match the NF Z 10-011 shape: the word CEDEX (any case) + optional 1-2 digit id.
 *   5. CA rows: the postcode is codex-valid (`normalizeCaPostalCode`) and its FSA first letter maps to
 *        the row's region via `FSA_LETTER_TO_PROVINCE`.
 *   6. Every row carries po_box and/or cedex (this shard has no other reason to exist).
 *
 *   Usage: node scripts/audit-po-box-cedex-shard.ts --input
 *   /tmp/po-box-shard/po-box-cedex-train.jsonl [--samples 8]
 */

import { parseArgs as parseNodeArgs } from "node:util"

import { FSA_LETTER_TO_PROVINCE, normalizeCaPostalCode } from "@mailwoman/codex/ca"
import { isPOBox } from "@mailwoman/codex/us"
import { JSONSpliterator } from "spliterator"

const CODEX_COVERED = /^(p\.?\s*o\.?\s*box|post\s+office\s+box|firm\s+caller|caller|drawer|lockbox|box)\s+/i
// The ENTIRE remainder after the designator must be one clean id token — space/comma-noised ids
// ("9 9 8 3", "1,234") are corpus-designed adversarial forms the codex regex rightly rejects.
const CLEAN_ID = /^[\dA-Za-z][\dA-Za-z-]*$/
const CEDEX_SHAPE = /^cedex(\s\d{1,2})?$/i

interface AuditOptions {
	input: string
	samples: number
}

interface ShardComponents {
	po_box?: string
	cedex?: string
	postcode?: string
	region?: string
	[key: string]: string | undefined
}

interface ShardRow {
	raw: string
	tokens: string[]
	labels: string[]
	components: ShardComponents
	span_starts?: number[]
	span_ends?: number[]
	span_tags?: string[]
	synth_method: string
	country: string
}

type SpanSlicesResult = { ok: false; reason: string } | { ok: true; byTag: Map<string, string[]> }

function parseArgs(): AuditOptions {
	const out: { input?: string; samples: number } = { samples: 8 }

	// node:util parseArgs (strict:false = old scan parity: unknown flags tolerated)
	const { values } = parseNodeArgs({
		options: { input: { type: "string" }, samples: { type: "string" } },
		strict: false,
		allowPositionals: true,
	})

	if (values["input"] != null) {
		out.input = values["input"] as string
	}

	if (values["samples"] != null) {
		out.samples = parseInt((values["samples"] as string) ?? "", 10)
	}

	if (!out.input) {
		console.error("Usage: audit-po-box-cedex-shard.ts --input <labeled.jsonl> [--samples N]")
		process.exit(1)
	}

	return out as AuditOptions
}

/**
 * Validate the #519 char-offset span triple's structure (present, parallel, sorted, in-bounds) and return the raw
 * slices per tag. Returns `{ ok: false, reason }` on a structural violation.
 */
function spanSlices(row: ShardRow): SpanSlicesResult {
	const { raw, span_starts, span_ends, span_tags } = row

	if (!span_starts || !span_ends || !span_tags) {
		return { ok: false, reason: "missing the char-offset span triple (#519)" }
	}

	if (span_starts.length !== span_ends.length || span_starts.length !== span_tags.length) {
		return {
			ok: false,
			reason: `span triple not parallel: ${span_starts.length}/${span_ends.length}/${span_tags.length}`,
		}
	}
	const byTag = new Map<string, string[]>()

	for (let i = 0; i < span_starts.length; i++) {
		const start = span_starts[i]!
		const end = span_ends[i]!
		const tag = span_tags[i]!

		if (!(start >= 0 && start < end && end <= raw.length)) {
			return { ok: false, reason: `span ${tag}@[${start}, ${end}) out of bounds` }
		}

		if (i > 0 && start < span_ends[i - 1]!) {
			return { ok: false, reason: `spans unsorted/overlapping at index ${i}` }
		}

		if (!byTag.has(tag)) {
			byTag.set(tag, [])
		}
		byTag.get(tag)!.push(raw.slice(start, end))
	}

	return { ok: true, byTag }
}

function bioWellFormed(labels: string[]): boolean {
	let prev = "O"

	for (const l of labels) {
		if (l.startsWith("I-")) {
			const tag = l.slice(2)

			if (prev !== `B-${tag}` && prev !== `I-${tag}`) return false
		}
		prev = l
	}

	return true
}

async function main(): Promise<void> {
	const opts = parseArgs()

	let rows = 0
	const failures: Array<{ reason: string; raw: string }> = []
	const fail = (row: ShardRow, reason: string) => failures.push({ reason, raw: row.raw })
	const byMethod: Record<string, number> = {}
	const tagCounts = { po_box: 0, cedex: 0 }
	const samples: Array<{ raw: string; labeled: string }> = []

	// JSONSpliterator yields already-parsed rows and tolerates CRLF (a trailing \r is JSON whitespace);
	// its default skipEmpty drops blank lines, matching the old `if (!line.trim()) continue`.
	for await (const row of JSONSpliterator.fromAsync<ShardRow>(opts.input)) {
		rows++
		byMethod[row.synth_method] = (byMethod[row.synth_method] ?? 0) + 1
		const { tokens, labels, components: c } = row

		if (tokens.length !== labels.length) {
			fail(row, "tokens/labels length mismatch")
		}

		if (!bioWellFormed(labels)) {
			fail(row, "malformed BIO")
		}

		if (!c.po_box && !c.cedex) {
			fail(row, "row carries neither po_box nor cedex")
		}

		// RAW-surface comparison via the #519 span triple — punctuation preserved, never stripped.
		const sliced = spanSlices(row)

		if (!sliced.ok) {
			fail(row, sliced.reason)
		} else {
			for (const tag of ["po_box", "cedex"] as const) {
				if (!c[tag]) continue
				tagCounts[tag]++
				const slices = sliced.byTag.get(tag) ?? []

				if (slices.length !== 1) {
					fail(row, `${tag}: expected 1 span, got ${slices.length}`)
				} else if (slices[0]!.toLowerCase() !== c[tag]!.toLowerCase()) {
					fail(row, `${tag} span "${slices[0]}" != component "${c[tag]}" (raw-surface, verbatim)`)
				}
			}
		}

		if (c.cedex && !CEDEX_SHAPE.test(c.cedex)) {
			fail(row, `cedex shape: "${c.cedex}"`)
		}

		if (c.po_box && row.country === "US") {
			const m = CODEX_COVERED.exec(c.po_box)

			if (m && CLEAN_ID.test(c.po_box.slice(m[0].length).trim()) && !isPOBox(c.po_box)) {
				fail(row, `codex rejects US po_box "${c.po_box}"`)
			}
		}

		if (row.country === "CA" && c.postcode) {
			const pc = normalizeCaPostalCode(c.postcode)

			if (!pc) {
				fail(row, `invalid CA postcode "${c.postcode}"`)
			} else if (c.region && FSA_LETTER_TO_PROVINCE[pc[0]!] !== c.region) {
				fail(row, `FSA ${pc[0]} != region ${c.region}`)
			}
		}

		if (samples.length < opts.samples && rows % 977 === 1) {
			samples.push({ raw: row.raw, labeled: tokens.map((t, i) => `${t}/${labels[i]}`).join(" ") })
		}
	}

	console.log(`rows: ${rows}`)
	console.log(`by synth_method: ${JSON.stringify(byMethod)}`)
	console.log(`tag coverage: ${JSON.stringify(tagCounts)}`)
	console.log(`\nsamples:`)

	for (const s of samples) {
		console.log(`  ${s.raw}\n    ${s.labeled}`)
	}

	if (failures.length > 0) {
		console.error(`\nFAIL: ${failures.length} rows`)

		for (const f of failures.slice(0, 20)) {
			console.error(`  [${f.reason}] ${f.raw}`)
		}
		process.exit(1)
	}
	console.log(`\nPASS: all ${rows} rows clean`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
