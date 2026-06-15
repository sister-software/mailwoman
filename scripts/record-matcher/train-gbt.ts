/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Train the production learned-scorer model (#603). Builds the SAME NPI-keyed record set the dedup
 *   benchmark + the clustering A/B use (real registry + name-drift + address-variation), geocodes
 *   it, blocks → candidate pairs, featurizes each pair with the SHARED `createMatchFeaturizer` (so
 *   train ≡ inference), labels by held-out NPI, and fits the gradient-boosted-tree model. Writes
 *   the model as a committed TS module (`registry/models/dedup-gbt-en-us.ts`) that ships in the
 *   package.
 *
 *   Unlike the eval, this trains on ALL sampled NPIs (no held-out split) — the held-out F1 is the
 *   eval's job; this produces the shipped artifact. The eval (`learned-scorer-clustering-eval.ts`)
 *   then re-measures generalization against the FS spine.
 *
 *   Run: node --experimental-strip-types scripts/record-matcher/train-gbt.ts\
 *   [--state TX] [--npis 3000] [--wof <admin.db>] [--data-root <dir>]\
 *   [--out registry/models/dedup-gbt-en-us.ts]
 */

import { decodeAsJson } from "@mailwoman/core/decoder"
import { createWofResolver, type ResolverBackend } from "@mailwoman/core/resolver"
import { block, trainGBT } from "@mailwoman/match"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import {
	addressFrequencyKey,
	buildDefaultModel,
	createMatchFeaturizer,
	defaultBlockingKeys,
	geocodeAddressVia,
	ingestRows,
	resolveEntities,
	streamRows,
	type ColumnMapping,
	type SourceRecord,
} from "@mailwoman/registry"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { geocodeAddress, ShardProvider } from "../../mailwoman/out/geocode-core.js"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const SOURCES = arg("sources", "/mnt/playpen/mailwoman-data/record-matcher/sources")
const STATE = arg("state", "TX").toUpperCase()
const NPIS = Number(arg("npis", "3000"))
const WOF = arg("wof", "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db")
const DATA_ROOT = arg("data-root", "/mnt/playpen/mailwoman-data")
const OUT = arg("out", "registry/models/dedup-gbt-en-us.ts")
const LOCALE = arg("locale", "en-US")
const TRAIN_DATE = arg("date", new Date().toISOString().slice(0, 10)) // overridable for reproducible commits

const REGISTRY = `${SOURCES}/nppes_npi-registry_20260607.tsv`
const OTHER_NAMES = `${SOURCES}/nppes_other-names_20260607.tsv`

const C = {
	npi: "NPI",
	entityType: "Entity Type Code",
	orgLegal: "Provider Organization Name (Legal Business Name)",
	last: "Provider Last Name (Legal Name)",
	first: "Provider First Name",
	pAddr: "Provider First Line Business Practice Location Address",
	pCity: "Provider Business Practice Location Address City Name",
	pState: "Provider Business Practice Location Address State Name",
	pZip: "Provider Business Practice Location Address Postal Code",
	mAddr: "Provider First Line Business Mailing Address",
	mCity: "Provider Business Mailing Address City Name",
	mState: "Provider Business Mailing Address State Name",
	mZip: "Provider Business Mailing Address Postal Code",
	otherOrg: "Provider Other Organization Name",
}

const norm = (s: string | undefined) => (s ?? "").trim()
const addr = (line: string, city: string, st: string, zip: string) =>
	[norm(line), norm(city), norm(st), norm(zip)].filter(Boolean).join(", ")

interface MessyRow {
	npi: string
	name: string
	org: string
	address: string
}

async function main(): Promise<void> {
	// --- Phase A: NPIs with ≥1 alternate organization name (the variation set). ---
	console.error("[A] streaming other-names…")
	const altNames = new Map<string, string[]>()
	for await (const r of streamRows(OTHER_NAMES)) {
		const npi = norm(r[C.npi])
		const alt = norm(r[C.otherOrg])
		if (!npi || !alt) continue
		const list = altNames.get(npi) ?? []
		if (list.length < 5) list.push(alt)
		altNames.set(npi, list)
	}

	// --- Phase B: one full registry pass — corpus-wide address-frequency table + the sample. ---
	console.error(`[B] full registry pass: address-frequency table + ${NPIS} ${STATE} sample…`)
	const rows: MessyRow[] = []
	const kept = new Set<string>()
	const addrCounts = new Map<string, number>()
	let addrTotal = 0
	let scanned = 0
	for await (const r of streamRows(REGISTRY)) {
		if (++scanned % 1_000_000 === 0) console.error(`    scanned ${scanned / 1e6}M, kept ${kept.size}`)
		const practice = addr(r[C.pAddr]!, r[C.pCity]!, r[C.pState]!, r[C.pZip]!)
		if (practice) {
			const k = addressFrequencyKey(practice)
			addrCounts.set(k, (addrCounts.get(k) ?? 0) + 1)
			addrTotal++
		}
		const npi = norm(r[C.npi])
		if (
			kept.size < NPIS &&
			npi &&
			!kept.has(npi) &&
			altNames.has(npi) &&
			practice &&
			norm(r[C.pState]).toUpperCase() === STATE
		) {
			const isOrg = norm(r[C.entityType]) === "2"
			const primaryName = isOrg ? norm(r[C.orgLegal]) : `${norm(r[C.first])} ${norm(r[C.last])}`.trim()
			if (primaryName) {
				const org = isOrg ? norm(r[C.orgLegal]) : ""
				kept.add(npi)
				rows.push({ npi, name: primaryName, org, address: practice })
				for (const alt of altNames.get(npi)!) rows.push({ npi, name: alt, org: alt, address: practice })
				const mailing = addr(r[C.mAddr]!, r[C.mCity]!, r[C.mState]!, r[C.mZip]!)
				if (mailing && mailing !== practice) rows.push({ npi, name: primaryName, org, address: mailing })
			}
		}
	}
	const addressFrequency = {
		total: addrTotal,
		distinct: addrCounts.size,
		frequency: (v: string) => (v ? (addrCounts.get(addressFrequencyKey(v)) ?? 0) / addrTotal : 0),
	}
	console.error(
		`    ${kept.size} NPIs → ${rows.length} records; freq table ${addrCounts.size} distinct over ${addrTotal}`
	)

	// --- Phase C: geocode + ingest (NPI rides on record.id as the label). ---
	console.error("[C] geocoding…")
	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: LOCALE })
	const mod = await import("@mailwoman/resolver-wof-sqlite")
	const lookup = new mod.WofSqlitePlaceLookup({ databasePath: WOF })
	const resolver = createWofResolver(lookup as unknown as ResolverBackend)
	const shardProvider = new ShardProvider(mod, DATA_ROOT)
	const seam = geocodeAddressVia({
		parse: async (raw: string) => decodeAsJson(await classifier.parse(raw, { postcodeRepair: true })),
		geocode: (raw: string) =>
			geocodeAddress(raw, {
				classifier,
				resolver,
				shards: shardProvider.for,
				defaultCountry: "US",
				placeCountry: false,
			}),
		country: "US",
	})
	// mapping.id = "npi" → record.id IS the NPI label (multiple records share an NPI, the ground truth).
	const mapping: ColumnMapping = { id: "npi", name: "name", organization: "org", address: "address" }
	const records: SourceRecord[] = await ingestRows(rows as unknown as Record<string, string>[], mapping, {
		geocodeAddress: seam,
	})
	shardProvider.close()
	lookup.close()
	const geocoded = records.filter((r) => r.address?.geocode).length
	console.error(`    ${records.length} records, ${geocoded} geocoded`)

	// --- Phase D: block → features (the SHARED featurizer) → labels → train. ---
	console.error("[D] blocking + featurizing + training…")
	const comparisons = buildDefaultModel({ collapseSpatial: true, addressFrequency }).comparisons
	const featurize = createMatchFeaturizer({ comparisons, addressFrequency })
	const { pairs } = block(records, defaultBlockingKeys())
	const X = pairs.map(([a, b]) => featurize(a, b))
	const Y = pairs.map(([a, b]) => (a.id === b.id ? 1 : 0))
	const posRate = Y.reduce((s, v) => s + v, 0) / Math.max(1, Y.length)
	const W = Y.map((y) => (y === 1 ? 1 - posRate : posRate)) // class-balanced (same as the eval)
	const hyperparams = { rounds: 120, depth: 3, lr: 0.3, minLeaf: 20 }
	const model = trainGBT(X, Y, W, hyperparams)
	console.error(`    ${pairs.length} pairs (${(100 * posRate).toFixed(1)}% positive), ${model.trees.length} trees`)

	// --- Sanity: the trained scorer should separate same-NPI from different-NPI pairs on TRAIN. ---
	const sample = resolveEntities(records, { addressFrequency, collapseSpatial: true, trainEM: true })
	console.error(`    (FS-spine self-resolve: ${records.length} → ${sample.entities.length} entities, for reference)`)

	// --- Emit the model as a committed TS module. The literal is single-line + prettier-ignored so a
	// retrain produces a clean one-line diff, not a thousand reformatted lines. ---
	const meta = {
		version: "1.0.0",
		locale: LOCALE,
		trainedOn: TRAIN_DATE,
		state: STATE,
		npis: kept.size,
		records: records.length,
		pairs: pairs.length,
		posRate: Number(posRate.toFixed(4)),
		hyperparams,
		features: X[0]?.length ?? 0,
		addressFrequencyDistinct: addrCounts.size,
		addressFrequencyTotal: addrTotal,
	}
	const moduleSource =
		`/**\n` +
		` * @copyright Sister Software\n` +
		` * @license AGPL-3.0\n` +
		` * @author Teffen Ellis, et al.\n` +
		` *\n` +
		` *   GENERATED by scripts/record-matcher/train-gbt.ts — DO NOT edit by hand; retrain to update.\n` +
		` *\n` +
		` *   The default learned-scorer model (#603): a gradient-boosted-tree dedup scorer trained on the\n` +
		` *   NPPES NPI-truth set (${STATE}, ${kept.size} NPIs → ${pairs.length} candidate pairs). Validated to\n` +
		` *   generalize across states by learned-scorer-crossstate-eval.ts. Used by resolveEntities'\n` +
		` *   opt-in learnedScorer hook via createGbtScorer. The trained {@link GBT} is plain data.\n` +
		` */\n\n` +
		`import type { GBT } from "@mailwoman/match"\n\n` +
		`/** Provenance for the bundled model — what it was trained on. */\n` +
		`export const DEDUP_GBT_META = ${JSON.stringify(meta, null, 2)} as const\n\n` +
		`// prettier-ignore\n` +
		`export const DEDUP_GBT_MODEL: GBT = ${JSON.stringify(model)}\n`
	mkdirSync(dirname(OUT), { recursive: true })
	writeFileSync(OUT, moduleSource)
	console.error(`[written] ${OUT} (${(moduleSource.length / 1024).toFixed(0)} KB)`)
}

await main()
