/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { writeLocalBuffer } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"
import {
	componentsForIDERecord,
	createIDEUruguayAdapter,
	IDE_UY_ADAPTER_ID,
	IDE_UY_LICENSE,
	type IDEUruguayRecord,
} from "#uy/adapters/ide/adapter"

const scratch = useScratchDir("ide-uy")

const HEADER =
	"latitud,longitud,punto_wkb,codigo_postal,codigo_via,nombre_via,num_puerta,letra_puerta,km,manzana,solar,nombre_inmueble,localidad,codigo_localidad,departamento"

/**
 * Lines as the IDE publishes them: Windows-1252, a nickname in doubled quotes, `N/A` for absent values.
 */
const LINES = [
	"-33.52,-56.90,00,85000,16165,BRASIL,807,N/A,N/A,29,4,N/A,TRINIDAD,844,FLORES",
	"-34.90,-56.16,00,11200,1,ORDOÑEZ,1234,BIS,N/A,N/A,N/A,N/A,MONTEVIDEO,1,MONTEVIDEO",
	'-34.79,-55.90,00,15800,18465,"AVENIDA JOSE ""PEPE"" D\' ELIA",186,A,N/A,132,22,N/A,EL PINAR,646,CANELONES',
	"-30.40,-56.46,00,55000,17626,PRESIDENTE TOMAS BERRETA,385,N/A,N/A,135,22,SUC CORREO ARTIGAS,ARTIGAS,135,ARTIGAS",
	"-30.95,-56.14,00,50000,44868,RUTA 30 - BRIGADIER GENERAL EUGENIO GARZON,N/A,N/A,200,N/A,N/A,N/A,ARTIGAS RURAL,3322,ARTIGAS",
	"-30.58,-57.67,00,55100,44682,UYARCPA_SN_013,12,N/A,N/A,N/A,N/A,N/A,COLONIA PALMA,357,ARTIGAS",
	"-34.50,-56.30,00,90200,57914,CAMINO VECINAL,77,DU,N/A,N/A,N/A,N/A,CANELONES RURAL,9,CANELONES",
]

const record = (fields: Partial<IDEUruguayRecord>): IDEUruguayRecord => ({
	codigo_postal: "N/A",
	codigo_via: "1",
	nombre_via: "N/A",
	num_puerta: "N/A",
	letra_puerta: "N/A",
	km: "N/A",
	nombre_inmueble: "N/A",
	localidad: "N/A",
	departamento: "N/A",
	latitud: "0",
	longitud: "0",
	...fields,
})

describe("componentsForIDERecord", () => {
	it("joins a BIS or single-letter suffix, keeps the department beside a locality, and drops a repeat", () => {
		expect(
			componentsForIDERecord(
				record({
					nombre_via: "ORDOÑEZ",
					num_puerta: "1234",
					letra_puerta: "BIS",
					codigo_postal: "11200",
					localidad: "MONTEVIDEO",
					departamento: "MONTEVIDEO",
				})
			)
		).toEqual({ street: "ORDOÑEZ", house_number: "1234 BIS", postcode: "11200", locality: "MONTEVIDEO" })
	})

	it("reads a rural remainder as the department alone and drops undefined suffix codes", () => {
		const dropped = new Map<string, number>()

		expect(
			componentsForIDERecord(
				record({
					nombre_via: "CAMINO VECINAL",
					num_puerta: "77",
					letra_puerta: "DU",
					codigo_postal: "90200",
					localidad: "CANELONES RURAL",
					departamento: "CANELONES",
				}),
				{ dropped }
			)
		).toEqual({ street: "CAMINO VECINAL", house_number: "77", postcode: "90200", region: "CANELONES" })

		expect(Object.fromEntries(dropped)).toEqual({
			"component:letra_puerta:code": 1,
			"component:locality:rural-remainder": 1,
		})
	})

	it("keeps a building name as the venue but not an agent's personal name or a code", () => {
		const dropped = new Map<string, number>()

		const named = (nombre_inmueble: string) =>
			componentsForIDERecord(
				record({ nombre_via: "SAN JOSE", num_puerta: "5", localidad: "BELLA UNION", nombre_inmueble }),
				{ dropped }
			)?.venue

		expect(named("SUC CORREO BELLA UNION")).toBe("SUC CORREO BELLA UNION")
		expect(named("Agente Bruno Nicolas Fernandez")).toBeUndefined()
		expect(named("CH109")).toBeUndefined()
		expect(Object.fromEntries(dropped)).toEqual({ "component:venue:names-a-person": 1, "component:venue:code": 1 })
	})

	it("refuses a generated street code and a point located only by route kilometer", () => {
		const dropped = new Map<string, number>()

		expect(
			componentsForIDERecord(record({ nombre_via: "UYARCPA_SN_013", num_puerta: "12", localidad: "X" }), { dropped })
		).toBeNull()

		expect(
			componentsForIDERecord(record({ nombre_via: "RUTA 30", km: "200", localidad: "ARTIGAS RURAL" }), { dropped })
		).toBeNull()

		expect(Object.fromEntries(dropped)).toEqual({
			"row:street-generated-code": 1,
			"row:route-kilometer-without-door-number": 1,
		})
	})
})

describe("ide-uy adapter", () => {
	it("decodes the Windows-1252 department files of a directory and stamps the publisher's license", async () => {
		const directory = scratch.path("departments")

		await writeLocalBuffer(Buffer.from([HEADER, ...LINES.slice(0, 4)].join("\r\n"), "latin1"), directory("a.csv"))
		await writeLocalBuffer(Buffer.from([HEADER, ...LINES.slice(4)].join("\r\n"), "latin1"), directory("b.csv"))

		const manifest = await runAdapter({
			adapter: createIDEUruguayAdapter(),
			adapterOptions: { inputPath: directory, country: "UY" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(5)

		const rows = await readCanonicalRows(scratch.path, IDE_UY_ADAPTER_ID)

		expect(rows.every((row) => row.license === IDE_UY_LICENSE && row.country === "UY")).toBe(true)
		expect(rows.map((row) => row.raw)).toContain("ORDOÑEZ 1234 BIS, 11200 MONTEVIDEO")
		expect(rows.some((row) => row.components.street === `AVENIDA JOSE "PEPE" D' ELIA`)).toBe(true)
		expect(rows.find((row) => row.components.venue)?.components.venue).toBe("SUC CORREO ARTIGAS")
	})
})
