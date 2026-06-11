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
 *   1. Tokens/labels parallel arrays + well-formed BIO (no orphan I-, no tag switch mid-run).
 *   2. The po_box span covers the WHOLE designator+number phrase: the po_box-labeled tokens equal
 *        components.po_box modulo punctuation (the whitespace tokenizer drops "."/"#", so
 *        comparison is on the letter/digit stream) — same for cedex. Exactly one span per tag.
 *   3. Codex round-trip: every US po_box phrase with a codex-covered designator and a clean id must
 *        satisfy `isPOBox` (POB / PMB / "#" / noisy-id forms are corpus-template territory,
 *        exempt).
 *   4. Cedex spans match the NF Z 10-011 shape: the word CEDEX (any case) + optional 1-2 digit id.
 *   5. CA rows: the postcode is codex-valid (`normalizeCaPostalCode`) and its FSA first letter maps to
 *        the row's region via `FSA_LETTER_TO_PROVINCE`.
 *   6. Every row carries po_box and/or cedex (this shard has no other reason to exist).
 *
 *   Usage: node scripts/audit-po-box-cedex-shard.mjs --input
 *   /tmp/po-box-shard/po-box-cedex-train.jsonl [--samples 8]
 */

import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"

import { FSA_LETTER_TO_PROVINCE, normalizeCaPostalCode } from "@mailwoman/codex/ca"
import { isPOBox } from "@mailwoman/codex/us"

const CODEX_COVERED = /^(p\.?\s*o\.?\s*box|post\s+office\s+box|firm\s+caller|caller|drawer|lockbox|box)\s+/i
// The ENTIRE remainder after the designator must be one clean id token — space/comma-noised ids
// ("9 9 8 3", "1,234") are corpus-designed adversarial forms the codex regex rightly rejects.
const CLEAN_ID = /^[\dA-Za-z][\dA-Za-z-]*$/
const CEDEX_SHAPE = /^cedex(\s\d{1,2})?$/i

const norm = (s) =>
	s
		.normalize("NFC")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.toLowerCase()

function parseArgs() {
	const args = process.argv.slice(2)
	const out = { samples: 8 }
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--input") out.input = args[++i]
		else if (args[i] === "--samples") out.samples = parseInt(args[++i], 10)
	}
	if (!out.input) {
		console.error("Usage: audit-po-box-cedex-shard.mjs --input <labeled.jsonl> [--samples N]")
		process.exit(1)
	}
	return out
}

/** Extract the contiguous spans for a tag from BIO labels; returns arrays of joined token text. */
function spansOf(tokens, labels, tag) {
	const spans = []
	let cur = null
	for (let i = 0; i < labels.length; i++) {
		if (labels[i] === `B-${tag}`) {
			if (cur) spans.push(cur)
			cur = [tokens[i]]
		} else if (labels[i] === `I-${tag}`) {
			if (!cur) return { spans, malformed: true } // orphan I-
			cur.push(tokens[i])
		} else if (cur) {
			spans.push(cur)
			cur = null
		}
	}
	if (cur) spans.push(cur)
	return { spans: spans.map((s) => s.join(" ")), malformed: false }
}

function bioWellFormed(labels) {
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

async function main() {
	const opts = parseArgs()
	const rl = createInterface({ input: createReadStream(opts.input, { encoding: "utf8" }), crlfDelay: Infinity })

	let rows = 0
	const failures = []
	const fail = (row, reason) => failures.push({ reason, raw: row.raw })
	const byMethod = {}
	const tagCounts = { po_box: 0, cedex: 0 }
	const samples = []

	for await (const line of rl) {
		if (!line.trim()) continue
		const row = JSON.parse(line)
		rows++
		byMethod[row.synth_method] = (byMethod[row.synth_method] ?? 0) + 1
		const { tokens, labels, components: c } = row

		if (tokens.length !== labels.length) fail(row, "tokens/labels length mismatch")
		if (!bioWellFormed(labels)) fail(row, "malformed BIO")
		if (!c.po_box && !c.cedex) fail(row, "row carries neither po_box nor cedex")

		for (const tag of ["po_box", "cedex"]) {
			if (!c[tag]) continue
			tagCounts[tag]++
			const { spans, malformed } = spansOf(tokens, labels, tag)
			if (malformed) fail(row, `orphan I-${tag}`)
			if (spans.length !== 1) fail(row, `${tag}: expected 1 span, got ${spans.length}`)
			else if (norm(spans[0]) !== norm(c[tag])) fail(row, `${tag} span "${spans[0]}" != component "${c[tag]}"`)
		}

		if (c.cedex && !CEDEX_SHAPE.test(c.cedex)) fail(row, `cedex shape: "${c.cedex}"`)

		if (c.po_box && row.country === "US") {
			const m = CODEX_COVERED.exec(c.po_box)
			if (m && CLEAN_ID.test(c.po_box.slice(m[0].length).trim()) && !isPOBox(c.po_box))
				fail(row, `codex rejects US po_box "${c.po_box}"`)
		}

		if (row.country === "CA" && c.postcode) {
			const pc = normalizeCaPostalCode(c.postcode)
			if (!pc) fail(row, `invalid CA postcode "${c.postcode}"`)
			else if (c.region && FSA_LETTER_TO_PROVINCE[pc[0]] !== c.region) fail(row, `FSA ${pc[0]} != region ${c.region}`)
		}

		if (samples.length < opts.samples && rows % 977 === 1) {
			samples.push({ raw: row.raw, labeled: tokens.map((t, i) => `${t}/${labels[i]}`).join(" ") })
		}
	}

	console.log(`rows: ${rows}`)
	console.log(`by synth_method: ${JSON.stringify(byMethod)}`)
	console.log(`tag coverage: ${JSON.stringify(tagCounts)}`)
	console.log(`\nsamples:`)
	for (const s of samples) console.log(`  ${s.raw}\n    ${s.labeled}`)
	if (failures.length > 0) {
		console.error(`\nFAIL: ${failures.length} rows`)
		for (const f of failures.slice(0, 20)) console.error(`  [${f.reason}] ${f.raw}`)
		process.exit(1)
	}
	console.log(`\nPASS: all ${rows} rows clean`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
