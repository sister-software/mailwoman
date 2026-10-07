/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Puts each row beside the Gobierno de Navarra's own address layer. In the slow suite, so the
 *   fast suite stays offline.
 *
 *   The publisher serves `IDENA:DIRECC_Txt_Direcciones` from `https://idena.navarra.es/ogc/wfs`,
 *   181,098 features carrying `MUNICIPIO`, `ENTIDAD`, `CODPOSTAL`, `VIA` and `PORTAL`. That is the
 *   register the INSPIRE partitions are drawn from, served by a second service, so it is this
 *   source's publisher-side oracle: partition 1's `AD.Address.1` composes
 *   `CALLE CALLEJA, 4, 31280 Abáigar`, and `DIRECC_Txt_Direcciones.1` reads `MUNICIPIO` `Abáigar`,
 *   `ENTIDAD` `Abáigar`, `CODPOSTAL` `31280`, `VIA` `CALLE CALLEJA`, `PORTAL` `4`.
 *
 *   Two differences between the publisher's own two services are normalized here rather than in the
 *   adapter, because the INSPIRE GML is the elected source and this layer is the check. The layer
 *   writes `S/N` in `PORTAL` where it holds no number. That is the statement the GML designator
 *   makes. And it separates a letter suffix differently, `3 - A` against the GML's `3 A`, so the
 *   comparison drops the separator on both sides.
 *
 *   Across all three partitions measured against this layer, 1,298 of 1,457 rows agreed on street,
 *   number, postcode and settlement at once. The 159 that did not are two street names in Eulate
 *   where the publisher's two services disagree with each other: the INSPIRE GML writes
 *   `CALLE COPALACIO ALTO` and `CALLE COPALACIO BAJO`, and this layer writes `COPARACIO`. Partition
 *   100 is therefore not in this fixture, and that disagreement is the publisher's rather than the
 *   reader's.
 *
 *   The service caps a page at 1,000 features and answers a request past the first page with zero
 *   features rather than the next page, so a municipality is read one settlement at a time and a
 *   short answer raises.
 */

import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { createESNavarraAdapter } from "#es/adapters/navarra/adapter"
import { LIVE_PUBLISHER_TESTS } from "#test-kit"

const TIMEOUT_MS = 180_000

const fixtureDir = workspacePath("corpus", "fixtures", "es-navarra")

/**
 * Every address the publisher's own layer holds for one municipality and settlement.
 */
async function publisherAddresses(
	municipality: string,
	settlement: string
): Promise<readonly Record<string, string>[]> {
	const filter = `MUNICIPIO='${municipality}' AND ENTIDAD='${settlement}'`

	const url =
		"https://idena.navarra.es/ogc/wfs?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature" +
		"&TYPENAMES=IDENA:DIRECC_Txt_Direcciones&OUTPUTFORMAT=application/json&COUNT=1000" +
		`&CQL_FILTER=${encodeURIComponent(filter)}`

	const response = await fetch(url)

	expect(response.ok).toBe(true)

	const payload = (await response.json()) as {
		features: { properties: Record<string, string> }[]
		numberMatched: number
	}

	// A page the service truncated would read as a municipality holding fewer addresses
	// than it does, and every row past the cap would look like a disagreement.
	expect(payload.features).toHaveLength(payload.numberMatched)

	return payload.features.map((feature) => feature.properties)
}

/**
 * The separator the publisher's two services space differently.
 */
function squash(value: string): string {
	return value.replaceAll(/[\s-]+/gu, "")
}

describe.runIf(LIVE_PUBLISHER_TESTS)("es-navarra rows against IDENA:DIRECC_Txt_Direcciones", () => {
	it(
		"agrees with the publisher's own layer on the street, the number, the postcode and the settlement",
		async () => {
			const rows = await Array.fromAsync(createESNavarraAdapter().rows({ inputPath: fixtureDir }))

			expect(rows).toHaveLength(6)

			const disagreements: string[] = []

			for (const row of rows) {
				const municipality = row.components.locality!
				const held = await publisherAddresses(municipality, row.components.dependent_locality ?? municipality)

				expect(held.length).toBeGreaterThan(0)

				const pairs = new Set(held.map((feature) => `${feature["VIA"]}\u0000${squash(feature["PORTAL"] ?? "")}`))
				const postcodes = new Set(held.map((feature) => feature["CODPOSTAL"]))
				const house = squash(row.components.house_number ?? "S/N")
				const postcodeOK = row.components.postcode === undefined || postcodes.has(row.components.postcode)

				if (!pairs.has(`${row.components.street}\u0000${house}`) || !postcodeOK) {
					disagreements.push(`${row.source_id}: composed ${row.raw}`)
				}
			}

			expect(disagreements).toEqual([])
		},
		TIMEOUT_MS
	)

	it(
		"still serves the feed whose terms the register elected",
		async () => {
			const response = await fetch(
				"https://filescartografia.navarra.es/2_CARTOGRAFIA_TEMATICA/2_7_CATASTRO/2_7_3_INSPIRE_ATOM/2_7_3_3_AD/Addresses_ServiceATOM_Navarra.xml"
			)

			expect(response.ok).toBe(true)

			const feed = await response.text()

			// The register rests on the feed's own `rights`, so the assertion is that the
			// feed still states it rather than that its byte count has not moved.
			expect(feed).toContain("Creative Commons Attribution 4.0 International (CC BY 4.0)")
			expect(feed).toContain("AD_Navarra_1.gml.zip")
		},
		TIMEOUT_MS
	)
})
