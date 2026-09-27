// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { titleCaseFR } from "@mailwoman/codex/fr"
import { describe, expect, it } from "vitest"

describe("titleCaseFR", () => {
	it("capitalizes elements and leaves French particles lowercase", () => {
		expect(titleCaseFR("saint-jean-de-luz")).toBe("Saint-Jean-de-Luz")
		expect(titleCaseFR("mery-sur-oise")).toBe("Mery-sur-Oise")
		expect(titleCaseFR("paris")).toBe("Paris")
	})

	it("capitalizes a leading particle — it is not a joiner there", () => {
		expect(titleCaseFR("le mans")).toBe("Le Mans")
		expect(titleCaseFR("la rochelle")).toBe("La Rochelle")
	})

	it("cases an elided article's noun", () => {
		expect(titleCaseFR("villeneuve-l'archevêque")).toBe("Villeneuve-l'Archevêque")
	})
})
