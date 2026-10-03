/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `bd-adresses`: the Administration du cadastre et de la topographie's BD-Adresses CSV adapter,
 * covering Luxembourg.
 *
 * Input is the semicolon-separated `addresses.csv` the ACT publishes for the whole country through
 * `data.public.lu`, beside a GeoJSON and a shapefile carrying the same records. The adapter reads
 * `rue` as the street, `numero` as the house number, and `code_postal` with `localite` as the
 * postcode and its postal locality.
 *
 * The publisher describes BD-Adresses as `un sous-ensemble des adresses figurant dans le registre
 * national des localités et des rues`, enriched with coordinates. The row count is therefore the
 * published subset rather than Luxembourg's address count.
 *
 * `data.public.lu` states `cc-zero` for the dataset, and the address-source register elects
 * `CC0-1.0` for `lu-property-building-1` on that statement, so the adapter records that license on
 * every row.
 *
 * Luxembourg writes the house number before the street, which `STREET_ORDERS` records as
 * `number-first`, and `COMMA_JOINED_STREET_COUNTRIES` does not list it. `formatAddressRow` therefore
 * renders `20 Kaesfurterstrooss, L-9755 Hupperdange`.
 *
 * ## The file carries one street name, in no single language
 *
 * Luxembourg is trilingual, and the CSV declares one street column.
 * There is no `rue_fr`, `rue_de` or `rue_lb` to choose between, so the adapter emits `rue` as the
 * publisher wrote it.
 *
 * What that column holds is mixed.
 * Measured over the 179,622 rows of the 2026-09-28 edition with a generic-word probe rather than a
 * language classifier: 133,449 values open with a French street generic such as `Rue`, `Avenue` or
 * `Montée`, 18,629 close with a Luxembourgish one such as `-strooss`, `-wee` or `-gaass`, and the
 * remaining 27,544 match neither probe and include plainly Luxembourgish forms such as
 * `Am Stengber`, `An Hiesel` and `Um Reebou`.
 * No column marks a row's language, so `locale` reads `und-LU`.
 * `und` is BCP-47's undetermined language subtag, and the repository already stores it in
 * `#recipes/bare/country` and `#tools/postcode-triples`.
 * Labeling every row `fr-LU` or `lb-LU` would assert a language for a name the publisher did not
 * tag.
 *
 * ## The number comes from `numero`, and never from the street line
 *
 * `rue` and `numero` are separate columns and the publisher never composes them, so neither
 * `splitStreetLine` nor `composeHouseNumber` applies here: there is no line to split and no second
 * column to join.
 * Splitting the street would also be wrong in both directions.
 * 175 `rue` values end in a digit, among them `Route Nationale 1`, `Rue du 9 août 2019` and
 * `Cité des Sacrifiés 1940-1945`.
 * `numero` already carries its own suffix as one token: 162,273 rows hold bare digits, 17,087 a
 * trailing letter such as `12A`, 239 a hyphenated range such as `22-26`, eight the word `BIS` or
 * `bis`, and 15 are empty.
 *
 * `id_geoportail` is the publisher's own composition of the same two values.
 * It ends in `_<id_caclr_rue>_<numero>` on 179,607 of the 179,607 numbered rows, so the number this
 * adapter emits agrees with the publisher's where the publisher states one.
 * The file publishes no preformatted address line, so a rendered single line has no publisher-side
 * counterpart to be asserted against.
 *
 * ## Reading the file needs a quote-aware parser
 *
 * 22 rows RFC 4180-quote `rue` and double its interior quotes:
 * `"Cité ""Pënscherbierg""";3;Wilwerwiltz;…`.
 * Those rows carry no semicolon inside the quotes, so a naive split on `;` still yields 13 fields
 * and passes a field-count check while handing the street to the corpus as
 * `"Cité ""Pënscherbierg"""`.
 * `CSVSpliterator` unescapes it to `Cité "Pënscherbierg"`.
 * The same edition carries 0 fields with an embedded newline and 0 carriage returns in the whole
 * file.
 *
 * The file opens with a UTF-8 byte-order mark, the three bytes `EF BB BF`, which the reader strips.
 * The first record's own first key therefore reads `rue` rather than the mark followed by `rue`.
 * That mark is why the portal's byte count exceeds by three what a reader that discards it reports.
 *
 * The adapter streams with `CSVSpliterator.fromAsync`.
 * It honors `opts.limit`, `opts.signal` and `opts.country`.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { CSVSpliterator } from "spliterator"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceID } from "#adapters/source-id"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const BD_ADRESSES_ADAPTER_ID = "bd-adresses"

/**
 * The license the address-source register elects for this publication.
 */
export const BD_ADRESSES_DEFAULT_LICENSE = "CC0-1.0"

/**
 * Every jurisdiction this adapter emits, checked against a caller's `--country`.
 *
 * BD-Adresses is one national file and Luxembourg has no dependency, so this is a single entry
 * where `ban`, `matrikkelen` and `ryhti` each carry more than one.
 */
export const BD_ADRESSES_COUNTRIES: readonly string[] = ["LU"]

/**
 * The subset of the 13 columns the adapter consults.
 *
 * The explicit shape catches a column rename early, because the adapter indexes the publisher's
 * own spelling and a renamed column would otherwise reach every row as an empty string.
 *
 * The seven columns left out are the two coordinate pairs, the building identifier
 * `id_caclr_bat`, the commune name and its `lau2` code.
 * None of them reaches a `CanonicalRow` component.
 */
interface BDAdressesRow {
	rue: string
	numero: string
	localite: string
	code_postal: string
	id_caclr_rue: string
	id_geoportail: string
}

/**
 * The columns `rows` indexes by name, in the order the published header declares them.
 *
 * A caller that downloads the file checks its header against this list.
 */
export const BD_ADRESSES_REQUIRED_COLUMNS: readonly string[] = [
	"rue",
	"numero",
	"localite",
	"code_postal",
	"id_caclr_rue",
	"id_geoportail",
]

export function createBDAdressesAdapter(): CorpusAdapter {
	return {
		id: BD_ADRESSES_ADAPTER_ID,
		defaultLicense: BD_ADRESSES_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.BDAdresses,
		surface: SurfaceOrigin.Rendered,
		description:
			"BD-Adresses (Administration du cadastre et de la topographie): street-level addresses for Luxembourg.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !BD_ADRESSES_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(BD_ADRESSES_ADAPTER_ID, BD_ADRESSES_COUNTRIES, opts.country)
			}

			const rows = CSVSpliterator.fromAsync(opts.inputPath, {
				normalizeKeys: false,
				columnDelimiter: ";",
			})

			let emitted = 0
			let unnamed = 0

			try {
				for await (const record of rows as AsyncIterable<BDAdressesRow>) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					const street = (record.rue ?? "").trim()
					const house = (record.numero ?? "").trim()
					const postcode = (record.code_postal ?? "").trim()
					const locality = (record.localite ?? "").trim()

					if (!street) {
						unnamed += 1

						continue
					}

					if (!postcode && !locality) continue

					const components: CanonicalRow["components"] = {}

					// 15 of the 179,622 rows publish an empty `numero`, among them `Al Géidgen`
					// in Goedange and `Jaanshaff` in Walferdange.
					// Those are named places, so they keep their street and postcode
					// rather than being assigned a number.
					if (house) {
						components.house_number = house
					}

					components.street = street

					if (postcode) {
						components.postcode = postcode
					}

					if (locality) {
						components.locality = locality
					}

					const rendered = formatAddressRow(components, "LU", { singleLine: true })

					if (!rendered) continue

					const { raw, components: aligned } = rendered
					const seed = (record.id_geoportail ?? "").trim()

					const sourceID = seed ? `${BD_ADRESSES_ADAPTER_ID}-${seed}` : stableSourceID(BD_ADRESSES_ADAPTER_ID, aligned)

					yield {
						raw,
						components: aligned,
						country: "LU",
						locale: "und-LU",
						source: BD_ADRESSES_ADAPTER_ID,
						source_id: sourceID,
						corpus_version: "",
						license: BD_ADRESSES_DEFAULT_LICENSE,
					}

					emitted++
				}
			} finally {
				if (unnamed > 0) {
					process.stderr.write(
						`  bd-adresses: ${unnamed} rows publish an empty rue and were dropped, ${emitted} kept\n`
					)
				}
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const bdAdressesAdapter = createBDAdressesAdapter()
