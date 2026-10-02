/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Puts each row beside the Cadastre's own rendering of the same cadastral reference. In the
 *   slow suite, so the fast suite stays offline.
 *
 *   The `Consulta_DNPRC` operation of the OVC web service answers a cadastral reference with the
 *   address the Cadastre holds for it: `tv` the street-type abbreviation, `nv` the street name,
 *   `pnp` the number, `plp` its letter, `dp` the postcode, `nm` the municipality, and `ldt` the
 *   whole line rendered. The reference is the tail of each `AD:Address`'s own `gml:id`, so every row
 *   the adapter writes is checkable against the publisher.
 *
 *   Measured over a stride across the whole of Ceuta's member rather than its first rows, the
 *   figures are in this suite's own assertions. The service answers HTTP 403 after a few hundred
 *   consecutive requests from one address, so {@link SAMPLE} is small and {@link DELAY_MS} is a
 *   second. An answer of `NO EXISTE NINGÚN INMUEBLE CON LOS PARÁMETROS INDICADOS` is a reference
 *   the AD theme publishes and the property query does not resolve, and it is counted as unreadable
 *   rather than as a disagreement.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { createESCatastroAdapter } from "#es/adapters/catastro/adapter"
import { LIVE_PUBLISHER_TESTS } from "#test-kit"

/**
 * How many of the fixture's rows to put against the service.
 */
const SAMPLE = 6

/**
 * The gap between requests.
 */
const DELAY_MS = 1000

const TIMEOUT_MS = 180_000

const fixture = workspacePath("corpus", "fixtures", "es-catastro", "A.ES.SDGC.AD.55101.gml")

/**
 * What the Cadastre holds for one cadastral reference.
 *
 * A reference can carry many units, each with its own `dir`: `9548010TE8794N`
 * answers eleven, at numbers 45 through 55.
 * The GML writes one address per number, so each field is read as the set the
 * service answers rather than as its first block.
 */
interface PublisherAnswer {
	error?: string
	streets: ReadonlySet<string>
	numbers: ReadonlySet<string | undefined>
	postcodes: ReadonlySet<string>
	municipalities: ReadonlySet<string>
}

function text(xml: string, tag: string): string | undefined {
	return new RegExp(`<${tag}>([^<]*)</${tag}>`, "u").exec(xml)?.[1]
}

async function publisherAnswer(reference: string): Promise<PublisherAnswer> {
	const url =
		"https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC" +
		`?Provincia=&Municipio=&RC=${reference}`

	const response = await fetch(url)

	const empty = {
		streets: new Set<string>(),
		numbers: new Set<string | undefined>(),
		postcodes: new Set<string>(),
		municipalities: new Set<string>(),
	}

	if (!response.ok) return { ...empty, error: `HTTP ${response.status}` }

	const xml = await response.text()

	if (!xml.includes("<dir>")) return { ...empty, error: text(xml, "des") ?? "the service answered no address" }

	const blocks = [...xml.matchAll(/<dir>[\s\S]*?<\/dir>/gu)].map((match) => match[0])

	return {
		// `tv` is the street type and `nv` its name, and the service omits either one, so the pair is
		// joined through a predicate that narrows away an absent field rather than through `Boolean`.
		streets: new Set(
			blocks.map((dir) =>
				[text(dir, "tv"), text(dir, "nv")].filter((part): part is string => part !== undefined).join(" ")
			)
		),
		// `pnp` and `plp` concatenate: `13` and `D` make `13D`.
		// A `pnp` of `0` with no `plp`, or no `pnp` at all, is the Cadastre holding no number,
		// which its own `ldt` shows by rendering none and which the GML writes as `S-N`.
		numbers: new Set(
			blocks.map((dir) => {
				const pnp = text(dir, "pnp")
				const plp = text(dir, "plp")

				if (!plp && (pnp === undefined || pnp === "" || pnp === "0")) return undefined

				return `${pnp ?? ""}${plp ?? ""}`
			})
		),
		postcodes: new Set([...xml.matchAll(/<dp>([^<]*)<\/dp>/gu)].map((match) => match[1]!)),
		municipalities: new Set([...xml.matchAll(/<nm>([^<]*)<\/nm>/gu)].map((match) => match[1]!)),
	}
}

describe.runIf(LIVE_PUBLISHER_TESTS)("es-catastro rows against the OVC Consulta_DNPRC service", () => {
	it(
		"agrees with the Cadastre on the street, the number, the postcode and the municipality",
		async () => {
			const rows = await Array.fromAsync(createESCatastroAdapter().rows({ inputPath: fixture }))

			expect(rows).toHaveLength(6)

			let readable = 0
			let agreed = 0
			const disagreements: string[] = []
			const unreadable: string[] = []

			for (const row of rows.slice(0, SAMPLE)) {
				const reference = row.source_id.split(".").at(-1)!
				const answer = await publisherAnswer(reference)

				await new Promise((resolve) => {
					setTimeout(resolve, DELAY_MS)
				})

				if (answer.error) {
					unreadable.push(`${reference}: ${answer.error}`)

					continue
				}

				readable++

				const streetOK = answer.streets.has(row.components.street ?? "")
				const numberOK = answer.numbers.has(row.components.house_number)

				const postcodeOK = answer.postcodes.size
					? answer.postcodes.has(row.components.postcode ?? "")
					: row.components.postcode === undefined

				const localityOK = answer.municipalities.has(row.components.locality ?? "")

				if (streetOK && numberOK && postcodeOK && localityOK) {
					agreed++
				} else {
					disagreements.push(
						`${reference}: composed ${row.raw}, publisher streets ${[...answer.streets].join("|")} ` +
							`numbers ${[...answer.numbers].join("|")} postcodes ${[...answer.postcodes].join("|")}`
					)
				}
			}

			// A run that reached none of the sample states a service this test could not read
			// rather than a reader it checked.
			// The service enforces an hourly quota per address and answers past it with HTTP 403
			// and `Peticion denegada. Ha superado el limite de peticiones por hora.`,
			// so the refusals are reported rather than counted as agreement.
			if (!readable) {
				throw new Error(
					`the OVC service answered none of ${SAMPLE} references: ${unreadable.join("; ")}. ` +
						"Wait for its hourly quota to reset and run this again."
				)
			}

			expect(disagreements).toEqual([])
			expect(agreed).toBe(readable)
		},
		TIMEOUT_MS
	)

	it(
		"still serves the member the fixture was copied from",
		async () => {
			const response = await fetch(
				"https://www.catastro.hacienda.gob.es/INSPIRE/Addresses/55/55101-CEUTA/A.ES.SDGC.AD.55101.zip"
			)

			expect(response.ok).toBe(true)

			const bytes = new Uint8Array(await response.arrayBuffer())

			// The archive is 354,647 bytes as the register recorded it.
			// The assertion is that the publisher still serves an archive of the same shape
			// rather than that its size has not moved, because the Cadastre reissues a
			// municipality whenever its register changes.
			expect(bytes.byteLength).toBeGreaterThan(100_000)
			expect(Buffer.from(bytes.subarray(0, 2)).toString("latin1")).toBe("PK")

			// The committed fixture declares the encoding this reader decodes.
			expect((await readLocalBuffer(fixture)).toString("utf8")).toContain('encoding="ISO-8859-1"')
		},
		TIMEOUT_MS
	)
})
