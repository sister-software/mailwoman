/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the `locale` recipe's OA CITY-noise normalization (#241). The classes come from the
 *   2026-07-02 full-stream audit of the ES/IT/NL sources — see the {@link cleanCityNoise} docstring
 *   for the audit numbers. The invariant under test: drop pseudo-localities, strip glued admin-code
 *   suffixes, and DON'T touch the audit-verified real names a naive suffix rule would mangle.
 */

import { describe, expect, it } from "vitest"

import { cleanCityNoise } from "./locale.js"

describe("cleanCityNoise", () => {
	it("drops ES cadastral pseudo-localities (comma / ≥4-digit run)", () => {
		expect(cleanCityNoise("Comunidad de 09076, 09150 y 09578")).toBeNull()
		expect(cleanCityNoise("Ledanía de 09162, 09290, 09412 y 09606")).toBeNull()
		expect(cleanCityNoise("Comunidad de Covarrubias, Quintanilla del Coco y Retuerta")).toBeNull()
	})

	it("strips the NL BAG parenthesized province code (the glued region-suffix class)", () => {
		expect(cleanCityNoise("Bergen (NH)")).toBe("Bergen")
		expect(cleanCityNoise("Rijswijk (GLD)")).toBe("Rijswijk")
		expect(cleanCityNoise("Hengelo (Gld)")).toBe("Hengelo")
	})

	it("keeps NL ordinal-prefixed real names (one digit is not a postcode run)", () => {
		expect(cleanCityNoise("2e Valthermond")).toBe("2e Valthermond")
		expect(cleanCityNoise("1e Exloërmond")).toBe("1e Exloërmond")
	})

	it("keeps ES/IT city-ends-with-province real toponyms", () => {
		expect(cleanCityNoise("Alhama de Almería")).toBe("Alhama de Almería")
		expect(cleanCityNoise("GENZANO DI ROMA")).toBe("GENZANO DI ROMA")
	})

	it("keeps ES bilingual slash co-names (the eval expects them verbatim)", () => {
		expect(cleanCityNoise("Laudio/Llodio")).toBe("Laudio/Llodio")
		expect(cleanCityNoise("Sant Vicent del Raspeig/San Vicente del Raspeig")).toBe(
			"Sant Vicent del Raspeig/San Vicente del Raspeig"
		)
	})

	it("does not strip a long parenthetical (only the 1–3-letter admin-code shape)", () => {
		expect(cleanCityNoise("Ciudad (Vieja)")).toBe("Ciudad (Vieja)")
	})

	it("returns null when stripping leaves nothing", () => {
		expect(cleanCityNoise("(NH)")).toBeNull()
	})
})
