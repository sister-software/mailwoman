/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `ide-uy`: the national address points of Uruguay, `Direcciones Geográficas del Uruguay`, which the
 * Infraestructura de Datos Espaciales (IDE) publishes on catalogodatos.gub.uy as one CSV per department.
 *
 * The CSVs are Windows-1252 (`ORDOÑEZ` reads `ORDO\xd1EZ`), and quote a street name that holds a
 * nickname in doubled quotes (`"AVENIDA JOSE ""PEPE"" D' ELIA"`). Absent values read `N/A`.
 *
 * The adapter reads `nombre_via` as the street, `num_puerta` with `letra_puerta` as the house number,
 * `codigo_postal` as the postcode, `localidad` as the locality, `departamento` as the region and
 * `nombre_inmueble` as a venue. A census locality named `<DEPARTAMENTO> RURAL` names the department's rural
 * remainder rather than a place, so such a row keeps the department and no locality. A street the register
 * leaves unnamed carries a generated code (`UYARMQA_SN_012`) and is dropped, as is a point located only by a
 * route kilometer, which has no door number to render.
 *
 * The IDE publishes the dataset under the Licencia de Datos Abiertos – Uruguay, which grants adaptation and
 * commercial use and requires the note of origin to name the provider, the license and the dataset, and to
 * mention changes. Every row records that license.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { decodeBytes } from "@mailwoman/core/fs/streams"
import { acceptPostcode } from "@mailwoman/postcode/country-formats"
import { resolvePath } from "path-ts"
import { CSVSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceIDFromParts } from "#adapters/source-id"
import { composeHouseNumber } from "#adapters/street-line"
import { SourceRegister } from "#registers"
import {
	AddressRole,
	type AdapterOptions,
	type CanonicalRow,
	type CorpusAdapter,
	countDropped,
	SurfaceOrigin,
} from "#types"

/**
 * Registry id for this adapter, stamped into every row it emits.
 */
export const IDE_UY_ADAPTER_ID = "ide-uy"

/**
 * The license the IDE publishes the dataset under.
 * It has no SPDX identifier.
 */
export const IDE_UY_LICENSE = "LicenseRef-Licencia-Datos-Abiertos-Uruguay-0.1"

/**
 * Every jurisdiction this adapter emits, checked against a caller's `--country`.
 */
export const IDE_UY_COUNTRIES: readonly string[] = ["UY"]

/**
 * The columns the adapter reads from each department's CSV.
 */
export interface IDEUruguayRecord {
	codigo_postal: string
	codigo_via: string
	nombre_via: string
	num_puerta: string
	letra_puerta: string
	km: string
	nombre_inmueble: string
	localidad: string
	departamento: string
	latitud: string
	longitud: string
}

const ABSENT = "N/A"

/**
 * A value, or null when the IDE writes it as absent.
 */
function present(value: string | undefined): string | null {
	const trimmed = value?.trim() ?? ""

	return trimmed && trimmed !== ABSENT ? trimmed : null
}

/**
 * The house-number suffixes `letra_puerta` holds that a door number is written with:
 * `BIS` and a single letter.
 *
 * The two-letter values (`DU`, `CC`, `TR`) are codes the dataset's metadata
 * does not define, so they are left off.
 */
const LETTER_SUFFIX = /^(?:BIS|[A-Z])$/u

/**
 * A street the register leaves unnamed carries a generated code, such as `UYARMQA_SN_012`.
 */
const GENERATED_STREET = /_SN_|^[A-Z0-9]+_[A-Z0-9_]+$/u

/**
 * Maps one record onto the components the corpus asserts, or returns null when the row is refused.
 *
 * Each refusal increments its reason in `dropped`.
 */
export function componentsForIDERecord(
	record: IDEUruguayRecord,
	dropped?: Pick<AdapterOptions, "dropped">
): CanonicalRow["components"] | null {
	const tally = dropped ?? {}
	const street = present(record.nombre_via)

	if (!street) {
		countDropped(tally, "row:no-street")

		return null
	}

	if (GENERATED_STREET.test(street)) {
		countDropped(tally, "row:street-generated-code")

		return null
	}

	const number = present(record.num_puerta)

	if (!number) {
		countDropped(tally, present(record.km) ? "row:route-kilometer-without-door-number" : "row:no-door-number")

		return null
	}

	const letter = present(record.letra_puerta)
	const suffix = letter && LETTER_SUFFIX.test(letter) ? letter : ""

	if (letter && !suffix) {
		countDropped(tally, "component:letra_puerta:code")
	}

	const components: CanonicalRow["components"] = {
		house_number: composeHouseNumber(number, suffix, " "),
		street,
	}

	const venue = present(record.nombre_inmueble)

	// A post office's distribution agent is listed under the agent's own name (`Agente` and a person's names),
	// and a code such as `CH109` names no place, so neither becomes a venue.
	if (venue && /^AGENTE\b/iu.test(venue)) {
		countDropped(tally, "component:venue:names-a-person")
	} else if (venue && !/\p{L}{3}/u.test(venue)) {
		countDropped(tally, "component:venue:code")
	} else if (venue) {
		components.venue = venue
	}

	const postcode = present(record.codigo_postal)
	const matched = postcode ? acceptPostcode(postcode, "UY") : null

	if (matched) {
		components.postcode = matched
	} else if (postcode) {
		countDropped(tally, "component:postcode:not-country-format")
	}

	const locality = present(record.localidad)
	const region = present(record.departamento)

	if (locality && !locality.endsWith(" RURAL")) {
		components.locality = locality
	} else if (locality) {
		countDropped(tally, "component:locality:rural-remainder")
	}

	if (region && region !== components.locality) {
		components.region = region
	}

	if (!components.locality && !components.postcode) {
		countDropped(tally, "row:no-locality-or-postcode")

		return null
	}

	return components
}

/**
 * The department CSVs an input names: the file itself, or every `.csv` in a directory, in name order.
 */
async function departmentFiles(inputPath: string): Promise<string[]> {
	const stat = await tryStat(inputPath)

	if (!stat?.isDirectory()) return [inputPath]

	const names = await Globerator.from("*.csv", { cwd: inputPath, absolute: false }).toSorted()

	return names.map((name) => `${inputPath}/${name}`)
}

export function createIDEUruguayAdapter(): CorpusAdapter {
	return {
		id: IDE_UY_ADAPTER_ID,
		defaultLicense: IDE_UY_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.UruguayIDEDirecciones,
		surface: SurfaceOrigin.Rendered,
		description: "Direcciones Geográficas del Uruguay (IDE Uruguay): national address points, one CSV per department.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !IDE_UY_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(IDE_UY_ADAPTER_ID, IDE_UY_COUNTRIES, opts.country)
			}

			let emitted = 0

			for (const file of await departmentFiles(resolvePath(opts.inputPath))) {
				// The largest department file is 65 MB, and the publisher fixes the partition, so each is decoded whole.
				const text = decodeBytes(await readLocalBuffer(file), "windows-1252")
				const records = CSVSpliterator.from<IDEUruguayRecord>(Buffer.from(text, "utf8"), { normalizeKeys: false })

				for (const record of records) {
					if (opts.signal?.aborted) return

					if (opts.limit !== undefined && emitted >= opts.limit) return

					const components = componentsForIDERecord(record, opts)

					if (!components) continue

					const rendered = formatAddressRow(components, "UY", { singleLine: true })

					if (!rendered) {
						countDropped(opts, "row:render-failed")

						continue
					}

					for (const tag of rendered.unplaced) {
						countDropped(opts, `component:${tag}:not-rendered`)
					}

					const { raw, components: aligned } = rendered

					yield {
						raw,
						components: aligned,
						country: "UY",
						locale: "es-UY",
						source: IDE_UY_ADAPTER_ID,
						// The point's coordinates separate two doors the rendered components cannot,
						// such as the several access points one `num_puerta` has on a corner lot.
						source_id: stableSourceIDFromParts(IDE_UY_ADAPTER_ID, {
							...aligned,
							lat: record.latitud ?? "",
							lon: record.longitud ?? "",
						}),
						corpus_version: "",
						license: IDE_UY_LICENSE,
					}

					emitted++
				}
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const ideUruguayAdapter = createIDEUruguayAdapter()
