/**
 * @copyright Sister Software
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"

import { renderAUPoBox, renderNZPoBox } from "#recipes/po/box/cedex/au-nz"
import { renderCaEn, renderCaFr } from "#recipes/po/box/cedex/ca"
import { renderBpFr, renderCedexFr } from "#recipes/po/box/cedex/fr"
import {
	FR_SOURCE,
	GEONAMES_CA,
	GEONAMES_POSTAL_AU,
	GEONAMES_POSTAL_NZ,
	isHoldoutLocality,
	readCaLocalities,
	readFrTuples,
	readPostalTuples,
	readUsTuples,
	US_EVAL_SOURCE,
	US_TRAIN_SOURCES,
} from "#recipes/po/box/cedex/sources"
import type { AUTuple, NZTuple, Rendered, USTuple } from "#recipes/po/box/cedex/types"
import { renderPmbUs, renderPoBoxUs } from "#recipes/po/box/cedex/us"
import { CLASS_MIX } from "#recipes/po/box/cedex/vocabulary"
import { sliceSourceID, type CanonicalSliceRow, type CorpusRecipe } from "#recipes/scaffold"
import { synthesizeMilitaryPoBoxRow } from "#synthesizers/po-box"
import { pick } from "#synthesizers/utils"
import { alignRow } from "#utils"

const COMPONENT_ORDER = ["house_number", "street", "po_box", "venue", "locality", "postcode", "region", "cedex"]

const orderComponents = (components: Record<string, string>): Record<string, string> =>
	Object.fromEntries(COMPONENT_ORDER.filter((key) => components[key]).map((key) => [key, components[key]!]))

const pickClass = (draw: number): string => {
	let accumulated = 0

	for (const [name, weight] of CLASS_MIX) {
		accumulated += weight

		if (draw < accumulated) return name
	}

	return CLASS_MIX.at(-1)![0]
}

/**
 * Generate PO-box and CEDEX rows from US, French, Canadian, Australian, and New Zealand source pools.
 */
export const poBoxCedexRecipe: CorpusRecipe = {
	name: "po-box-cedex",
	description: "PO box / CEDEX coverage rows (US/FR/CA/AU/NZ) — self-generated from cached OA + GeoNames pools",
	mode: "generate",
	options: [{ flag: "--golden", description: "Emit the leakage-safe holdout variant ({raw, components, country})" }],
	async run(opts, write) {
		const random = makeMulberry32(opts.seed)
		const count = opts.count ?? 50_000
		const source = opts.sourceName ?? "synth-po-box-cedex"
		const usPool: USTuple[] = []

		for (const sourceEntry of opts.golden ? [US_EVAL_SOURCE] : US_TRAIN_SOURCES) {
			const tuples = await readUsTuples(sourceEntry)

			console.error(`  ${sourceEntry.csv}: ${tuples.length} tuples`)

			for (const tuple of tuples) {
				usPool.push(tuple)
			}
		}

		const frAll = await readFrTuples(80_000)
		const frPool = frAll.filter((tuple) => isHoldoutLocality(tuple.locality) === opts.golden)

		console.error(`  ${FR_SOURCE.csv}: ${frAll.length} tuples (${frPool.length} after holdout split)`)

		const qcAll = await readCaLocalities("10"),
			onAll = await readCaLocalities("08")

		const qcPool = qcAll.filter((locality) => isHoldoutLocality(locality) === opts.golden),
			onPool = onAll.filter((locality) => isHoldoutLocality(locality) === opts.golden)

		console.error(`  GeoNames CA: QC ${qcAll.length}→${qcPool.length}, ON ${onAll.length}→${onPool.length}`)

		const auAll = (await readPostalTuples(GEONAMES_POSTAL_AU, { withState: true })) as AUTuple[],
			nzAll = (await readPostalTuples(GEONAMES_POSTAL_NZ, { withState: false })) as NZTuple[]

		const auPool = auAll.filter((tuple) => isHoldoutLocality(tuple.locality) === opts.golden),
			nzPool = nzAll.filter((tuple) => isHoldoutLocality(tuple.locality) === opts.golden)

		console.error(`  GeoNames postal: AU ${auAll.length}→${auPool.length}, NZ ${nzAll.length}→${nzPool.length}`)

		if (!usPool.length || !frPool.length || !qcPool.length || !onPool.length || !auPool.length || !nzPool.length)
			throw new Error(
				`A base pool is empty — check ${dataRootPath("oa-cache")}, ${GEONAMES_CA}, ${GEONAMES_POSTAL_AU.zip}, and ${GEONAMES_POSTAL_NZ.zip}.`
			)

		let emitted = 0,
			skipped = 0,
			guard = 0

		while (emitted < count && guard++ < count * 10) {
			const kind = pickClass(random())
			let rendered: Rendered
			let country: string
			let locale: string

			if (kind === "po-box-us") {
				rendered = renderPoBoxUs(random, pick(usPool, random))
				country = "US"
				locale = "en-US"
			} else if (kind === "pmb-us") {
				const tuple = pick(usPool, random)

				if (!tuple.postcode || !tuple.street || !tuple.house_number) continue
				rendered = renderPmbUs(random, tuple)
				country = "US"
				locale = "en-US"
			} else if (kind === "bp-fr") {
				rendered = renderBpFr(random, pick(frPool, random))
				country = "FR"
				locale = "fr-FR"
			} else if (kind === "cedex-fr") {
				rendered = renderCedexFr(random, pick(frPool, random))
				country = "FR"
				locale = "fr-FR"
			} else if (kind === "cp-ca-fr") {
				rendered = renderCaFr(random, pick(qcPool, random))
				country = "CA"
				locale = "fr-CA"
			} else if (kind === "po-box-au") {
				rendered = renderAUPoBox(random, pick(auPool, random))
				country = "AU"
				locale = "en-AU"
			} else if (kind === "po-box-nz") {
				rendered = renderNZPoBox(random, pick(nzPool, random))
				country = "NZ"
				locale = "en-NZ"
			} else if (kind === "po-box-us-military") {
				const military = synthesizeMilitaryPoBoxRow({ random })
				const { country: _country, ...components } = military.components
				rendered = { fmt: "po-box-military", raw: military.raw, components: components as Record<string, string> }
				country = "US"
				locale = "en-US"
			} else {
				rendered = renderCaEn(random, pick(onPool, random))
				country = "CA"
				locale = "en-CA"
			}

			const { raw, components } = rendered

			if (!Object.values(components).every((value) => raw.includes(value))) {
				skipped++

				continue
			}

			if (opts.golden) {
				write(JSON.stringify({ raw, components: orderComponents(components), country }) + "\n")

				emitted++

				continue
			}

			const canonical: CanonicalSliceRow = {
				raw,
				components: orderComponents(components),
				country,
				locale,
				source,
				source_id: sliceSourceID(source, components),
				corpus_version: "0.4.0",
				license:
					country === "CA"
						? "GeoNames CA (CC-BY 4.0) locality skeletons + Canada Post box forms (corpus templates); postcodes synthesized to the codex CA pattern"
						: country === "FR"
							? "OpenAddresses FR (BAN-derived) skeletons + La Poste BP/CEDEX forms (corpus templates, NF Z 10-011)"
							: country === "AU"
								? "GeoNames AU postal dump (CC-BY 4.0) locality/state/postcode tails + Australia Post Postal Delivery Type designators (@mailwoman/codex/au)"
								: country === "NZ"
									? "GeoNames NZ postal dump (CC-BY 4.0) locality/postcode tails + NZ Post ADV358 Delivery Service Types (@mailwoman/codex/nz)"
									: "OpenAddresses US (non-VT) skeletons + USPS Pub-28 §29 PO-box designators (codex/corpus templates)",
			}

			const aligned = alignRow(canonical as Parameters<typeof alignRow>[0])

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++

				continue
			}

			write(JSON.stringify({ ...aligned.row, synth_method: kind, synth_base_id: null }) + "\n")

			emitted++
		}

		return { emitted, skipped }
	},
}
