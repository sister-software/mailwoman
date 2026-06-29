/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build/probe CONSISTENCY is the only contract the locale normalizer must hold: the OSM `addr:street`
 *   tag and the parser's `street` constituent must fold to the same key. These cases lock the FR/DE/NL
 *   folding (and the Paris acceptance key) so a future tweak can't silently desync the two sides.
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { normalizeStreetForKeyLocale } from "@mailwoman/resolver-wof-sqlite/street-normalize"

import { streetLocaleForCountry, supportedOsmCountries } from "./street-locale.js"

test("fr: the Paris acceptance address keys consistently", () => {
	const key = normalizeStreetForKeyLocale("Rue du Chevaleret", "fr")
	assert.equal(key, "rue du chevaleret")
	// however a downstream source spells it, it folds to the same key
	assert.equal(normalizeStreetForKeyLocale("rue du chevaleret", "fr"), key)
})

test("fr: leading type abbreviations + Saint expand", () => {
	assert.equal(normalizeStreetForKeyLocale("Av. des Champs-Élysées", "fr"), "avenue des champs elysees")
	assert.equal(normalizeStreetForKeyLocale("Bd Saint-Germain", "fr"), "boulevard saint germain")
	assert.equal(normalizeStreetForKeyLocale("Rue St-Honoré", "fr"), "rue saint honore")
	assert.equal(normalizeStreetForKeyLocale("Pl. de la République", "fr"), "place de la republique")
})

test("de: glued -str(.) / -straße all fold to -strasse", () => {
	const k = "lindenstrasse"
	assert.equal(normalizeStreetForKeyLocale("Lindenstraße", "de"), k)
	assert.equal(normalizeStreetForKeyLocale("Lindenstr.", "de"), k)
	assert.equal(normalizeStreetForKeyLocale("Lindenstr", "de"), k)
	assert.equal(normalizeStreetForKeyLocale("lindenstrasse", "de"), k)
	// a non-str name is untouched
	assert.equal(normalizeStreetForKeyLocale("Marienplatz", "de"), "marienplatz")
})

test("nl: glued -str folds to -straat", () => {
	assert.equal(normalizeStreetForKeyLocale("Kerkstraat", "nl"), "kerkstraat")
	assert.equal(normalizeStreetForKeyLocale("Kerkstr.", "nl"), "kerkstraat")
	assert.equal(normalizeStreetForKeyLocale("Kerkstr", "nl"), "kerkstraat")
})

test("streetLocaleForCountry: maps the shipped countries, throws otherwise", () => {
	assert.equal(streetLocaleForCountry("FR"), "fr")
	assert.equal(streetLocaleForCountry("de"), "de")
	assert.equal(streetLocaleForCountry("nl"), "nl")
	assert.deepEqual(supportedOsmCountries().sort(), ["de", "fr", "nl"])
	assert.throws(() => streetLocaleForCountry("xx"), /No street-normalization locale/)
})
