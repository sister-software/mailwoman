/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expandAbbreviations } from "@mailwoman/normalize/abbreviations"
import { describe, expect, it } from "vitest"

describe("expandAbbreviations — en-US", () => {
	it("expands street suffixes (St → Street)", () => {
		const r = expandAbbreviations("350 5th St")
		expect(r.text).toBe("350 5th Street")
		expect(r.expansions).toHaveLength(1)
		expect(r.expansions[0]?.from).toBe("St")
		expect(r.expansions[0]?.to).toBe("Street")
	})

	it("expands street suffixes case-insensitively", () => {
		expect(expandAbbreviations("350 5th st").text).toBe("350 5th Street")
		expect(expandAbbreviations("350 5th ST").text).toBe("350 5th Street")
	})

	it("expands trailing-period abbreviations (St. → Street)", () => {
		const r = expandAbbreviations("350 5th St.")
		expect(r.text).toBe("350 5th Street")
		expect(r.expansions[0]?.from).toBe("St.")
	})

	it("expands multiple abbreviations in one string", () => {
		const r = expandAbbreviations("1600 Pennsylvania Ave NW")
		expect(r.text).toBe("1600 Pennsylvania Avenue Northwest")
		expect(r.expansions).toHaveLength(2)
	})

	it("preserves non-abbreviation tokens", () => {
		const r = expandAbbreviations("350 5th Avenue")
		expect(r.text).toBe("350 5th Avenue")
		expect(r.expansions).toHaveLength(0)
	})

	it("preserves punctuation between tokens", () => {
		const r = expandAbbreviations("350 5th Ave, NYC")
		expect(r.text).toBe("350 5th Avenue, NYC")
	})

	it("offsetMap points back to the source token start", () => {
		const r = expandAbbreviations("Ave")
		expect(r.text).toBe("Avenue")
		// All expanded chars point to position 0..2 of "Ave" (with last 3 chars all pointing at 2)
		expect(r.map[0]).toBe(0) // A
		expect(r.map[1]).toBe(1) // v
		expect(r.map[2]).toBe(2) // e
		expect(r.map[3]).toBe(2) // n (inserted; clamped to last source char)
		expect(r.map[4]).toBe(2) // u (inserted)
		expect(r.map[5]).toBe(2) // e (inserted)
	})
})

describe("expandAbbreviations — fr-FR", () => {
	it("expands French street abbreviations", () => {
		const r = expandAbbreviations("8 R République", "fr-FR")
		expect(r.text).toBe("8 Rue République")
		expect(r.expansions).toHaveLength(1)
	})

	it("expands Bd → Boulevard", () => {
		const r = expandAbbreviations("Bd Saint-Michel", "fr-FR")
		expect(r.text).toBe("Boulevard Saint-Michel")
	})
})

describe("expandAbbreviations — es-ES / es-MX", () => {
	// `Av.` is Avenida in Spanish and Avenue in French. Until 2026-08-05 there was no Spanish table at
	// all, so every `es-*` locale fell through to the en-US default and `Av.` went unexpanded, while
	// the locale-UNKNOWN set the geocode path uses expanded it to the ENGLISH "Avenue". Both MX rows in
	// the 2026-08-05 gauntlet batch record the second half of that (mx-op3-san-miguel-canada-zapopan,
	// pr-op3-place-at-the-sea-ponce) and had to leave `street` unasserted because of it.
	it("expands Av. → Avenida, not Avenue", () => {
		const r = expandAbbreviations("Av. Aurelio Ortega 460", "es-MX")
		expect(r.text).toBe("Avenida Aurelio Ortega 460")
		expect(r.expansions).toHaveLength(1)
		expect(r.expansions[0]?.from).toBe("Av.")
		expect(r.expansions[0]?.to).toBe("Avenida")
	})

	it("expands the period-free and the Avda/Avd spellings", () => {
		expect(expandAbbreviations("3499 Av Los Meros", "es-ES").text).toBe("3499 Avenida Los Meros")
		expect(expandAbbreviations("Avda. de América 12", "es-ES").text).toBe("Avenida de América 12")
		expect(expandAbbreviations("AVD DE LA CONSTITUCIÓN", "es-ES").text).toBe("Avenida DE LA CONSTITUCIÓN")
	})

	it("leaves the English suffixes alone under a Spanish locale", () => {
		// `Ave`/`St`/`Blvd` are en-US table entries; a Spanish address that happens to contain one is
		// not an invitation to expand it into English.
		expect(expandAbbreviations("Calle 5 Ave", "es-MX").text).toBe("Calle 5 Ave")
	})
})

describe("expandAbbreviations — the Av collision across locales", () => {
	it("keeps en-US and fr-FR readings intact", () => {
		// English abbreviates Avenue as "Ave", never "Av" — so en-US must not touch it.
		expect(expandAbbreviations("100 Av. Los Meros", "en-US").text).toBe("100 Av. Los Meros")
		expect(expandAbbreviations("1600 Pennsylvania Ave NW", "en-US").text).toBe("1600 Pennsylvania Avenue Northwest")
		expect(expandAbbreviations("1 Av. de la Convention", "fr-FR").text).toBe("1 Avenue de la Convention")
	})

	// TRACKED DEFECT, pinned so a fix is a deliberate change and not a surprise. The locale-UNKNOWN set
	// is what the geocode path uses (`normalize(input, { locale: "und" })` in mailwoman/geocode-core.ts),
	// because Stage 1 runs before the parse that would establish the locale. `Av` is in that set on the
	// claim that it "reads Avenue in both" — true of en/fr, false of es/pt, which is how Spanish input
	// acquires an English street type. It cannot simply be dropped here: the gauntlet row
	// fr-op3-halles-market-bonneuil is a `pass` that asserts street "Avenue de la Convention" AND an
	// address_point tier, so removing the entry needs a resolver-gauntlet run, not a table edit.
	it("still expands Av → the English Avenue under locale 'und'", () => {
		expect(expandAbbreviations("3499 Av. Los Meros", "und").text).toBe("3499 Avenue Los Meros")
	})
})

describe("expandAbbreviations — no-ops", () => {
	it("leaves unknown words alone", () => {
		const r = expandAbbreviations("Bonjour Mailwoman")
		expect(r.text).toBe("Bonjour Mailwoman")
		expect(r.expansions).toHaveLength(0)
	})

	it("handles empty input", () => {
		const r = expandAbbreviations("")
		expect(r.text).toBe("")
		expect(r.expansions).toHaveLength(0)
	})
})
