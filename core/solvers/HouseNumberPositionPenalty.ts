/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Alpha2LanguageCode, type Solver, type SolverContext } from "@mailwoman/core"

const basePenalty = 0.05

const numberLastLangs = new Map<string, number>([
	[Alpha2LanguageCode.German, basePenalty],
	[Alpha2LanguageCode.Slovenian, basePenalty],
	[Alpha2LanguageCode.Polish, basePenalty],
	[Alpha2LanguageCode.Bosnian, basePenalty],
	[Alpha2LanguageCode.Croatian, basePenalty],
	[Alpha2LanguageCode.Dutch, basePenalty],
	[Alpha2LanguageCode.Czech, basePenalty],
	[Alpha2LanguageCode.Danish, basePenalty],
	// Guatemala & Honduras do not flip their house numbers
	[Alpha2LanguageCode.Spanish, basePenalty / 2],
	[Alpha2LanguageCode.Finnish, basePenalty],
	[Alpha2LanguageCode.GreekModern_1453, basePenalty],
	[Alpha2LanguageCode.Icelandic, basePenalty],
	[Alpha2LanguageCode.Italian, basePenalty],
	[Alpha2LanguageCode.NorwegianBokmål, basePenalty],
	[Alpha2LanguageCode.Portuguese, basePenalty],
	[Alpha2LanguageCode.Swedish, basePenalty],
	[Alpha2LanguageCode.Slovak, basePenalty],
	[Alpha2LanguageCode.Turkish, basePenalty],
	[Alpha2LanguageCode.Romanian, basePenalty],
	[Alpha2LanguageCode.Hungarian, basePenalty],
])

const numberFirstLangs = new Map<string, number>([
	[Alpha2LanguageCode.English, basePenalty],
	// Switzerland and Andorre has some French streets.
	[Alpha2LanguageCode.French, basePenalty / 2],
])

export class HouseNumberPositionPenalty implements Solver {
	solve({ solutions }: SolverContext): void {
		for (const solution of solutions) {
			const houseNumber = solution.find("house_number")
			const street = solution.find("street")

			if (!houseNumber || !street || !street.languages) {
				continue
			}

			const { languages } = street

			// For now, we don't supports multi-lang entries.
			if (languages.size !== 1) continue

			const [lang] = languages

			if (!lang || lang === "all") return

			const numberLastLangMatch = numberLastLangs.get(lang)
			const numberFirstMatch = numberFirstLangs.get(lang)

			// Check if the number should be in last position (after street) or first position (before street).
			if (typeof numberLastLangMatch === "number" && houseNumber.span.start < street.span.start) {
				solution.penalty += numberLastLangMatch
			} else if (typeof numberFirstMatch === "number" && street.span.start < houseNumber.span.start) {
				solution.penalty += numberFirstMatch
			}
		}
	}
}
