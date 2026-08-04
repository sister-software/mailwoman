#!/usr/bin/env node
//
// be-panel — thirty Belgian address lines through the local pipeline, in three configurations.
//
// WHY BELGIUM
//
// Belgium is not a measured locale. No Belgian rooftop register ships, and no `nl-BE` or `fr-BE`
// weights package exists, so a Belgian user today installs the base weights and resolves against the
// global admin gazetteer. This panel measures what that actually gets them, which is a different
// question from the one a tier-1 locale answers. It also carries the case Belgium is uniquely good
// for: five Brussels streets appear twice, once in Dutch and once in French, so a bilingual pair
// tests whether two surface forms of the same street reach the same place.
//
// THREE ARMS
//
//   base            base weights, nothing configured — what `npm install` plus a gazetteer gives you.
//   fr-overlay      the French weights overlay, nothing else changed — does the nearest measured
//                   locale help a country that is half French-speaking?
//   country-pinned  base weights with `defaultCountry: "BE"` — what a reader who knows their file is
//                   Belgian would actually set.
//
// Each arm answers a question a reader arrives with. None of them is a Belgian model, because there
// is no Belgian model.
//
// WHAT IS GRADED, AND AGAINST WHAT
//
// There is no Belgian ground-truth coordinate set here, so nothing on this page claims a distance to
// a true rooftop. Four things are measurable without one:
//
//   1. Resolution — did a coordinate come back at all, and at which tier.
//   2. Country routing — is the coordinate inside Belgium's bounding box, and does the result name BE.
//      This is the real risk: Belgian place names collide with Dutch, French and Slovenian ones, so a
//      cross-border miss is the failure mode worth catching. The first two arms leave the country
//      unpinned so this is earned rather than assumed; the third pins it, which is the point of it.
//   3. Locality — does the resolved commune match the one the address belongs to. The accepted forms
//      are committed in `be-panel.json`, one list per row, covering the Dutch, French and English
//      spellings a gazetteer may carry.
//   4. Bilingual agreement — for each of the five pairs, how far apart the two language forms land.
//      This one needs no ground truth at all: the two rows name the same street, so any distance
//      between them is the pipeline disagreeing with itself.
//
// USAGE
//
//   npm install mailwoman @mailwoman/neural @mailwoman/neural-weights-en-us \
//               @mailwoman/neural-weights-fr-fr @mailwoman/resolver \
//               @mailwoman/resolver-wof-sqlite @mailwoman/spatial
//   mailwoman data pull candidate
//   node be-panel.mjs --data-root <DATA_ROOT> --out be-results.json
//
// `--data-root` defaults to $MAILWOMAN_DATA_ROOT. The candidate gazetteer is read from
// <DATA_ROOT>/wof/candidate.db. No other artifact is needed — that is the point of the panel.

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { WOFCandidateTableLookup } from "@mailwoman/resolver-wof-sqlite"
import { haversineKm } from "@mailwoman/spatial"
import { geocodeAddress } from "mailwoman/geocode-core"

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The three configurations, each named for the reader question it answers. `geocodeOpts` is merged into the per-row
 * `geocodeAddress` call; everything not named here stays at the shipped default, including the coarse-placer country
 * prior and its hard filter.
 */
const ARMS = [
	{ name: "base", locale: "en-US", geocodeOpts: {} },
	{ name: "fr-overlay", locale: "fr-FR", geocodeOpts: {} },
	{ name: "country-pinned", locale: "en-US", geocodeOpts: { defaultCountry: "BE" } },
]

/** Two forms of the same street this far apart count as agreeing. */
const PAIR_AGREEMENT_KM = 0.1

const { values: flags } = parseArgs({
	options: {
		"data-root": { type: "string" },
		out: { type: "string", default: join(HERE, "be-results.json") },
		panel: { type: "string", default: join(HERE, "be-panel.json") },
	},
})

// This file is served at /benchmarks/be-panel.mjs and runs in a READER's project, where
// `@mailwoman/core/env` — the blessed env helper inside this repo — is not a dependency.
// oxlint-disable-next-line sister-software/no-process-globals -- shipped doc asset; runs outside this repo
const dataRoot = flags["data-root"] ?? process.env.MAILWOMAN_DATA_ROOT

if (!dataRoot) {
	console.error("be-panel: pass --data-root <path> or set $MAILWOMAN_DATA_ROOT.")

	// oxlint-disable-next-line sister-software/no-process-globals -- shipped doc asset
	process.exit(1)
}

const candidatePath = join(dataRoot, "wof", "candidate.db")

/**
 * Fold a place name to the form the committed `acceptedLocality` lists are written in: lowercase, no diacritics, no
 * punctuation, single spaces. `Liège` and `LIEGE` both fold to `liege`.
 */
function fold(name) {
	return name
		.normalize("NFD")
		.replaceAll(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replaceAll(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
}

/**
 * Two locality checks, deliberately kept apart.
 *
 * `parsed` reads `result.locality` — the span the model labeled. It is close to circular: the commune is right there in
 * the input string, so a high number here says the parser found a token, not that anything was resolved.
 *
 * `resolved` reads only the nodes the resolver decorated (`result.hierarchy`). That is the number that means the
 * gazetteer agreed. Collapsing the two into one metric was the first version of this harness, and it scored a row that
 * landed in Slovenia as a locality hit because the parsed span still said the right thing.
 */
function localityChecks(result, accepted) {
	const acceptedSet = new Set(accepted.map(fold))

	// A decorated node carries a gazetteer `name`; `value` is the parsed text the node was matched
	// from. Both are collected because the two differ on an exonym (`Antwerp` against `Antwerpen`),
	// and either is a legitimate way for the gazetteer to have agreed. Absent fields are dropped.
	const hierarchyNames = (result.hierarchy ?? []).flatMap((node) => [node.name, node.value]).filter(Boolean)

	return {
		parsed: Boolean(result.locality) && acceptedSet.has(fold(result.locality)),
		resolved: hierarchyNames.some((name) => acceptedSet.has(fold(name))),
		hierarchyNames: [...new Set(hierarchyNames)],
	}
}

function inBox(box, lat, lon) {
	return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon
}

async function runArm(arm, panel) {
	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: arm.locale })
	const lookup = new WOFCandidateTableLookup({ databasePath: candidatePath })
	const resolver = createWOFResolver(lookup)
	const records = []

	try {
		for (const row of panel.rows) {
			let result

			try {
				result = await geocodeAddress(row.input, { classifier, resolver, ...arm.geocodeOpts })
			} catch (error) {
				records.push({
					id: row.id,
					input: row.input,
					error: error instanceof Error ? error.message : String(error),
				})

				continue
			}

			const hasCoordinate = typeof result.lat === "number" && typeof result.lon === "number"
			const locality = localityChecks(result, row.acceptedLocality)

			records.push({
				id: row.id,
				input: row.input,
				language: row.language,
				area: row.area,
				pair: row.pair,
				lat: result.lat,
				lon: result.lon,
				tier: result.resolution_tier,
				countryCode: result.countryCode,
				inBelgium: hasCoordinate && inBox(panel.bbox, result.lat, result.lon),
				localityParsed: locality.parsed,
				localityResolved: locality.resolved,
				hierarchyNames: locality.hierarchyNames,
				parsed: {
					house_number: result.house_number,
					street: result.street,
					postcode: result.postcode,
					locality: result.locality,
				},
			})
		}
	} finally {
		lookup.close()
	}

	// Every pair the panel declares is reported, including the ones that cannot be measured. Dropping
	// an unmeasurable pair from the denominator was the first version of this harness, and it turned a
	// row that returned no coordinate at all into a silent 4-of-4.
	const byPair = new Map()

	for (const record of records) {
		if (!record.pair) continue

		const bucket = byPair.get(record.pair) ?? []

		bucket.push(record)
		byPair.set(record.pair, bucket)
	}

	const pairs = [...byPair.entries()].map(([pair, bucket]) => {
		const [a, b] = bucket
		const comparable = bucket.length === 2 && typeof a.lat === "number" && typeof b.lat === "number"

		return {
			pair,
			nl: bucket.find((r) => r.language === "nl")?.input ?? null,
			fr: bucket.find((r) => r.language === "fr")?.input ?? null,
			comparable,
			// `null` here means "not measured because a side returned no coordinate", which is a
			// different fact from "measured, and the two sides disagree by 0 km".
			km: comparable ? Number(haversineKm(a.lat, a.lon, b.lat, b.lon).toFixed(4)) : null,
			sameTier: bucket.length === 2 ? a.tier === b.tier : null,
		}
	})

	const tiers = {}

	for (const record of records) {
		tiers[record.tier ?? "none"] = (tiers[record.tier ?? "none"] ?? 0) + 1
	}

	return {
		summary: {
			arm: arm.name,
			locale: arm.locale,
			geocodeOpts: arm.geocodeOpts,
			n: records.length,
			resolved: records.filter((r) => typeof r.lat === "number").length,
			inBelgium: records.filter((r) => r.inBelgium).length,
			countryCodeBE: records.filter((r) => r.countryCode === "BE").length,
			localityParsed: records.filter((r) => r.localityParsed).length,
			localityResolved: records.filter((r) => r.localityResolved).length,
			tiers,
			pairsDeclared: pairs.length,
			pairsComparable: pairs.filter((p) => p.comparable).length,
			pairsAgreeing: pairs.filter((p) => p.comparable && p.km <= PAIR_AGREEMENT_KM).length,
			worstPairKm: pairs.some((p) => p.comparable)
				? Math.max(...pairs.filter((p) => p.comparable).map((p) => p.km))
				: null,
		},
		pairs,
		records,
	}
}

const panel = JSON.parse(readFileSync(flags.panel, "utf8"))
const startedAt = Date.now()
const results = {}

for (const arm of ARMS) {
	results[arm.name] = await runArm(arm, panel)
}

const report = {
	harness: "be-panel.mjs",
	ranAt: new Date().toISOString(),
	elapsedMs: Date.now() - startedAt,
	panel: { rows: panel.rows.length, bbox: panel.bbox },
	config: {
		gazetteer: "candidate.db",
		nationalTier: "none — no Belgian rooftop register ships",
		pairAgreementKm: PAIR_AGREEMENT_KM,
	},
	arms: Object.fromEntries(Object.entries(results).map(([name, arm]) => [name, arm.summary])),
	pairs: Object.fromEntries(Object.entries(results).map(([name, arm]) => [name, arm.pairs])),
	records: Object.fromEntries(Object.entries(results).map(([name, arm]) => [name, arm.records])),
}

writeFileSync(flags.out, `${JSON.stringify(report, null, "\t")}\n`)

for (const [name, summary] of Object.entries(report.arms)) {
	console.log(
		`${name.padEnd(15)} n=${summary.n} resolved=${summary.resolved} inBelgium=${summary.inBelgium} ` +
			`cc=BE:${summary.countryCodeBE} locality parsed=${summary.localityParsed} resolved=${summary.localityResolved} ` +
			`pairs agreeing=${summary.pairsAgreeing} comparable=${summary.pairsComparable} declared=${summary.pairsDeclared} ` +
			`worstPair=${summary.worstPairKm}km`
	)
	console.log(`${" ".repeat(15)} tiers ${JSON.stringify(summary.tiers)}`)
}

console.log(`wrote ${resolve(flags.out)}`)
