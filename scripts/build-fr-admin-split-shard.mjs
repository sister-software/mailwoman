#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the FR admin-split coverage shard (night 2026-06-19, surpass-v1.5.0). Teaches the model to
 *   SPLIT the département out of the locality on bare/space/comma-delimited French place rows — the
 *   admin-deciding failure class the pre-GPU self-validation proved moves the resolved coordinate
 *   (collision communes −61%; see docs/articles/evals/2026-06-19-fr-admin-split-prevalidation.md).
 *
 *   Failure shapes (the model currently mis-handles all of these):
 *
 *   - `Thauron, Creuse` → région dropped to null (the comma+full-name miss)
 *   - `Montredon, Lozère` → région = "ère" (the diacritic subword split, #727)
 *   - (AU analog) `CANBERRA ACT` → the space-delimited admin fuse
 *
 *   The département is the load-bearing admin unit for FR postal geography and maps to the `region`
 *   component tag in our schema (gold `region` = `Creuse`/`Lozère` in the golden fr set). We derive
 *   it DETERMINISTICALLY from the real postcode via codex `departementForCodePostal` (first two
 *   digits = département) — salvage-first, no re-derived table.
 *
 *   Data: REAL BAN (Base Adresse Nationale) commune+postcode+coord tuples. Build the input TSV once:
 *   awk -F';' 'NR>1{key=$8"|"$6; if(!(key in s)&&$8&&$6&&$13&&$14){s[key]=1; print
 *   $8"\t"$6"\t"$13"\t"$14}}'\
 *   /mnt/playpen/mailwoman-data/corpus/staging/ban-france.csv > /tmp/reg/fr-communes.tsv (~35.3k
 *   distinct communes, all départements, real postcodes — 99.9% land the postcode anchor.)
 *
 *   Anchor-ON by construction: rows carry a REAL postcode token in `raw` + a `postcode` component, so
 *   the training loader paints the anchor feature onto that span automatically (data_loader.py →
 *   tokenizer.py `_paint_anchor_chars`). The trailing-postcode anchor REINFORCES the FR split (FR
 *   postcode is trailing, unlike German PLZ-leading — the v0.9.2 scar is positional, not
 *   universal).
 *
 *   Pipeline (mirrors build-fr-order-shard.mjs):
 *
 *   1. Node scripts/build-fr-admin-split-shard.mjs --output /tmp/fr-admin-split-train.jsonl --count
 *        60000 --seed 42
 *   2. Python3 scripts/jsonl-to-parquet.py --input /tmp/fr-admin-split-train.jsonl --output
 *        <NEW>/train/part-fr-admin-split-train.parquet
 *   3. Assemble overlay MANIFEST; stage parquet to the corpus volume (R2→rclone)
 *   4. Recipe: add `synth-fr-admin-split: <weight>` to data.source_weights, then train. `--golden` emits
 *        a held-out eval slice ({raw, components, country, lat, lon}) for the centroid gate.
 */

import { departementForCodePostal } from "@mailwoman/codex/fr"
import { alignRow, stableSourceId } from "@mailwoman/corpus"
import { createReadStream, createWriteStream } from "node:fs"
import { createInterface } from "node:readline"

/** Mulberry32 — reproducible PRNG (matches every other shard builder). */
function mulberry32(seed) {
	let a = seed >>> 0
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function parseArgs() {
	const args = process.argv.slice(2)
	const out = {
		count: 60000,
		seed: 42,
		source: "synth-fr-admin-split",
		communes: "/tmp/reg/fr-communes.tsv",
		allcapsProb: 0.1,
		golden: false,
	}
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--output") out.output = args[++i]
		else if (a === "--count") out.count = parseInt(args[++i], 10)
		else if (a === "--seed") out.seed = parseInt(args[++i], 10)
		else if (a === "--source-name") out.source = args[++i]
		else if (a === "--communes") out.communes = args[++i]
		else if (a === "--golden") out.golden = true
	}
	if (!out.output) {
		console.error(
			"Usage: build-fr-admin-split-shard.mjs --output <labeled.jsonl> [--count N] [--seed N] [--communes tsv] [--golden]"
		)
		process.exit(1)
	}
	return out
}

/** Read the distinct commune TSV (commune, postcode, lon, lat); derive the département name. */
async function readCommunes(path) {
	const rows = []
	const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity })
	for await (const line of rl) {
		if (!line) continue
		const [commune, postcode, lon, lat] = line.split("\t")
		if (!commune || !postcode) continue
		const dep = departementForCodePostal(postcode)
		if (!dep) continue // bad/unmappable postcode — skip (CEDEX, etc.)
		// Substring invariant: a département whose name isn't a clean token (none are) or a commune
		// containing the département name would confuse alignment — both are vanishingly rare here.
		rows.push({ commune, postcode, departement: dep.name, lon, lat })
	}
	return rows
}

/**
 * Render one admin-split variant. The CORE teaching signal: the département, even as a full word
 * after a comma or a space, is `region` — never folded into `locality`. Variants 1-3 are the
 * failure class; 4-5 are canonical-FR preservation so the model doesn't over-fire region on every
 * trailing token (and the bare commune still resolves).
 */
function render(random, c) {
	const r = random()
	const loc = random() < 0.1 ? c.commune.toUpperCase() : c.commune
	const dep = c.departement
	const pc = c.postcode
	let out
	if (r < 0.25) {
		// 1. bare comma, NO postcode — the Thauron/#727 shape (anchor off)
		out = { raw: `${loc}, ${dep}`, components: { locality: loc, region: dep }, order: "bare-comma" }
	} else if (r < 0.5) {
		// 2. bare comma + postcode — anchor ON
		out = {
			raw: `${loc}, ${dep} ${pc}`,
			components: { locality: loc, region: dep, postcode: pc },
			order: "bare-comma-pc",
		}
	} else if (r < 0.7) {
		// 3. space-delimited admin (the AU `CANBERRA ACT` fuse applied to FR) — anchor ON
		out = { raw: `${loc} ${dep} ${pc}`, components: { locality: loc, region: dep, postcode: pc }, order: "space-pc" }
	} else if (r < 0.85) {
		// 4. canonical FR postcode-first (NO département) — preservation, anchor ON
		out = { raw: `${pc} ${loc}`, components: { postcode: pc, locality: loc }, order: "canonical-pc-first" }
	} else {
		// 5. commune + postcode (NO département) — preservation, anchor ON
		out = { raw: `${loc} ${pc}`, components: { locality: loc, postcode: pc }, order: "commune-pc" }
	}
	// fr.country preservation (the v1.8.0 #728 finding): the v1.8.0 shard's bare rows carried NO country
	// token, so the model under-emitted country on FR (fr.country −3.5pp). ~20% of rows now append an
	// explicit "France" + a `country` component — the model relearns to emit country WHEN the token is
	// present without over-firing it on the (still-majority) country-less rows. Substring invariant holds.
	if (random() < 0.2) {
		out = {
			raw: `${out.raw}, France`,
			components: { ...out.components, country: "France" },
			order: `${out.order}+fr`,
		}
	}
	return out
}

async function main() {
	const opts = parseArgs()
	const random = mulberry32(opts.seed)
	const pool = await readCommunes(opts.communes)
	console.error(`  ${opts.communes}: ${pool.length} communes with derived département`)
	if (pool.length === 0) {
		console.error("No communes — build the TSV from BAN first (see header).")
		process.exit(1)
	}

	const outStream = createWriteStream(opts.output, { encoding: "utf8" })
	let emitted = 0,
		skipped = 0,
		guard = 0
	const orderCounts = {}
	const N = pool.length

	while (emitted < opts.count && guard++ < opts.count * 12) {
		const base = pool[Math.floor(random() * N)]
		const { raw, components, order } = render(random, base)

		// Alignment precondition: every component surface appears verbatim in raw.
		const values = Object.values(components).filter(Boolean)
		if (!values.every((v) => raw.includes(v))) {
			skipped++
			continue
		}

		if (opts.golden) {
			// Held-out eval slice for the centroid gate — carries the truth coordinate.
			outStream.write(
				JSON.stringify({ raw, components, country: "FR", lat: Number(base.lat), lon: Number(base.lon) }) + "\n"
			)
			emitted++
			orderCounts[order] = (orderCounts[order] ?? 0) + 1
			continue
		}

		const sourceId = stableSourceId(opts.source, {
			locality: components.locality,
			region: components.region,
			postcode: components.postcode,
		})
		const canonical = {
			raw,
			components,
			country: "FR",
			locale: "fr-FR",
			source: opts.source,
			source_id: sourceId,
			corpus_version: "0.5.0",
			license: "BAN (Base Adresse Nationale) commune+postcode tuples, rendered admin-split — see ingest SOURCE",
		}
		const aligned = alignRow(canonical)
		if (aligned.kind !== "labeled" || !aligned.row) {
			skipped++
			continue
		}
		outStream.write(
			JSON.stringify({ ...aligned.row, synth_method: "fr-admin-split", synth_order: order, synth_base_id: null }) + "\n"
		)
		emitted++
		orderCounts[order] = (orderCounts[order] ?? 0) + 1
	}

	outStream.end()
	console.error(`  emitted=${emitted} skipped=${skipped} order-mix=${JSON.stringify(orderCounts)}`)
}

await main()
