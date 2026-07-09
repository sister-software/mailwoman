#!/usr/bin/env npx tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

///<reference types="node" />

import "@mailwoman/corpus/adapters"
import { parseArgs } from "node:util"

import { runIfScript } from "@mailwoman/core/scripting"
import { defaultAdapterRegistry } from "@mailwoman/corpus"
import { buildCorpus } from "@mailwoman/corpus/build"
import { compileLicenseExcludes, SHARE_ALIKE_PATTERN } from "@mailwoman/corpus/license"

const CORPUS_VERSION = "0.3.0"
const OUTPUT = `/mnt/playpen/mailwoman-data/corpus/versioned/v${CORPUS_VERSION}`
const ROOT = "/mnt/playpen/mailwoman-data/corpus/sources"

const adapterInputs: Record<string, { inputPath: string; country?: string }> = {
	"wof-admin": { inputPath: `${ROOT}/wof/whosonfirst-data/` },
	"wof-postalcode": { inputPath: `${ROOT}/wof/whosonfirst-data/` },
	ban: { inputPath: `${ROOT}/ban/ban-national.csv` },
	// tiger.db (tiger_streets + tiger_places) is built by the mailwoman CLI:
	//   mailwoman tiger fetch --state <fips> --level place    --out <ROOT>/tiger/tiger.db
	//   mailwoman tiger fetch --state <fips> --level addrfeat --out <ROOT>/tiger/tiger.db
	tiger: { inputPath: `${ROOT}/tiger/tiger.db` },
	"usgov-hrsa-fqhc": { inputPath: `${ROOT}/usgov-hrsa-fqhc/Health_Center_Service_Delivery_and_LookAlike_Sites.csv` },
	"usgov-nppes": { inputPath: `${ROOT}/usgov-nppes/npidata_pfile_20050523-20260510.csv` },
	"usgov-imls-pls": { inputPath: `${ROOT}/usgov-imls-pls/pls_fy23_outlet_pud23i.csv` },
	// New in v0.3.0 — US DOT NAD (~97M structured 911-grade address points).
	// Directory of NDJSON shards fetched by `scripts/fetch-nad.ts`.
	"usgov-nad": { inputPath: `${ROOT}/usgov-nad/featureserver` },
	"state-ia-contractors": {
		inputPath: `${ROOT}/state-ia-contractors/IA_Active_Construction_Contractor_Registrations.csv`,
	},
	"state-ny-notaries": { inputPath: `${ROOT}/state-ny-notaries/NY_Commissioned_Notaries.csv` },
	"state-tx-notaries": { inputPath: `${ROOT}/state-tx-notaries/TX_Notary_Public_Commissions.csv` },
	// Deferred to v0.4.0:
	//   - openaddresses (OA-CA): waiting on PR #56 per-row license filter
	//   - usgov-samhsa-treatment-locator: bulk source broken per issue #33
	//   - state-de-notaries / state-hi-lobbyists / state-hi-schools /
	//     state-or-notaries / state-wa-health-providers: data on disk but no
	//     adapter code yet (Phase 1.6.x cluster issues #35-#41)
}

async function main() {
	const start = Date.now()
	// Deliberate license exclusion (#26): default includes EVERYTHING. Pass `--exclude-share-alike`
	// for a proprietary-weights build (drops ODbL/CC-BY-SA/CC-SA), or `--exclude-licenses "X,Y"` to
	// purposely drop named license prefixes. Exclusion is an explicit operator act, never a default.
	// node:util parseArgs (strict:false = old scan parity: unknown flags tolerated)
	const { values } = parseArgs({
		options: { "exclude-licenses": { type: "string" }, "exclude-share-alike": { type: "boolean" } },
		strict: false,
		allowPositionals: true,
	})
	const excludeLicenses: RegExp[] = []

	if (values["exclude-licenses"] != null) {
		excludeLicenses.push(...compileLicenseExcludes(values["exclude-licenses"] as string))
	}

	if (values["exclude-share-alike"] === true) {
		excludeLicenses.push(SHARE_ALIKE_PATTERN)
	}

	process.stderr.write(`=== Corpus v${CORPUS_VERSION} build ===\n`)
	process.stderr.write(`Output: ${OUTPUT}\n`)
	process.stderr.write(`Adapters: ${Object.keys(adapterInputs).join(", ")}\n`)
	process.stderr.write(
		excludeLicenses.length > 0
			? `License exclusion: ${excludeLicenses.map((r) => r.source).join(" | ")}\n\n`
			: `License exclusion: NONE — all licenses included (#26: pass --exclude-share-alike for proprietary weights)\n\n`
	)

	const manifest = await buildCorpus({
		outputDir: OUTPUT,
		corpusVersion: CORPUS_VERSION,
		adapterInputs,
		adapters: defaultAdapterRegistry.list(),
		synthesize: true,
		excludeLicenses,
	})

	const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1)
	process.stderr.write(`\n=== Build complete in ${elapsed} min ===\n`)
	process.stderr.write(`Total aligned rows: ${manifest.total_aligned_rows.toLocaleString()}\n`)
	process.stderr.write(`Quarantined: ${manifest.quarantine_count.toLocaleString()}\n`)
	process.stderr.write(
		`Adapted: ${manifest.adapters.map((a) => `${a.adapter_id} (${a.yielded.toLocaleString()})`).join(", ")}\n`
	)

	if (manifest.skipped_adapters.length) {
		process.stderr.write(`Skipped: ${manifest.skipped_adapters.join(", ")}\n`)
	}
}

runIfScript(main)
