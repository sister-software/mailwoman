/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The deprecation shim's two promises: every name a published consumer already imports still
 *   resolves, and it resolves to the SAME value `@mailwoman/neural` exports — the identity the module
 *   docstring relies on for `instanceof` to hold across both specifiers.
 *
 *   Nothing else exercises this package. It is imported by no workspace (that is the point of
 *   deprecating it), and the clean-install smoke closure skips it, so `tsc -b` is the only other thing
 *   standing between a renamed neural export and a consumer's import-time crash. Type-checking does
 *   not see two failures this does: a binding that arrives `undefined` — the bare/subpath cycle
 *   hazard AGENTS.md documents for this package family, where the barrel's re-exports evaluate before
 *   the slice that defines them — and a re-export accidentally rewritten as a wrapper, which
 *   type-checks perfectly and breaks every `instanceof` a caller had.
 */

import * as browser from "@mailwoman/neural/browser"
import * as webLoader from "@mailwoman/neural/web-loader"
import * as webRunner from "@mailwoman/neural/web-onnx-runner"
import { describe, expect, test } from "vitest"

import * as shim from "./index.ts"
import {
	DEFAULT_FIXED_SEQ_LEN,
	defaultGazetteerLexiconURL,
	detectPairIndexCountry,
	loadNeuralClassifierFromURLs,
	MailwomanTokenizer,
	NeuralAddressClassifier,
	PairIndexResolver,
	peekPairIndexHeader,
	resolvePairGateCountry,
	resolvePairIndexForText,
	WebONNXRunner,
} from "./index.ts"

/**
 * Each re-exported runtime value paired with the one the source module defines. Type-only re-exports are absent by
 * construction — they carry no runtime binding to compare.
 */
const REEXPORTS: Array<[name: string, viaShim: unknown, viaSource: unknown]> = [
	["defaultGazetteerLexiconURL", defaultGazetteerLexiconURL, webLoader.defaultGazetteerLexiconURL],
	["detectPairIndexCountry", detectPairIndexCountry, webLoader.detectPairIndexCountry],
	["loadNeuralClassifierFromURLs", loadNeuralClassifierFromURLs, webLoader.loadNeuralClassifierFromURLs],
	["resolvePairGateCountry", resolvePairGateCountry, webLoader.resolvePairGateCountry],
	["resolvePairIndexForText", resolvePairIndexForText, webLoader.resolvePairIndexForText],
	["DEFAULT_FIXED_SEQ_LEN", DEFAULT_FIXED_SEQ_LEN, webRunner.DEFAULT_FIXED_SEQ_LEN],
	["WebONNXRunner", WebONNXRunner, webRunner.WebONNXRunner],
	["MailwomanTokenizer", MailwomanTokenizer, browser.MailwomanTokenizer],
	["NeuralAddressClassifier", NeuralAddressClassifier, browser.NeuralAddressClassifier],
	["PairIndexResolver", PairIndexResolver, browser.PairIndexResolver],
	["peekPairIndexHeader", peekPairIndexHeader, browser.peekPairIndexHeader],
]

describe("@mailwoman/neural-web re-exports @mailwoman/neural at identity", () => {
	test.each(REEXPORTS)("%s", (name, viaShim, viaSource) => {
		expect(viaShim, `${name} is unbound`).toBeDefined()
		expect(viaShim).toBe(viaSource)
	})

	test("carries no runtime export this file does not check", () => {
		const declared = new Set(REEXPORTS.map(([name]) => name))
		const exported = Object.keys(shim)

		// A name added to the shim without a row above is not a failure of the shim — it is this test
		// going out of date, and silently, since the loop only checks what it already lists.
		expect(exported.filter((key) => !declared.has(key))).toEqual([])
	})
})
