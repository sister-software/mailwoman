/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compares the in-place matcher with the object matcher over every state of the staged en-US FST gazetteer, the
 *   file `mwops release copy-weights` writes into `@mailwoman/neural-weights-en-us`.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { describe, expect, test } from "vitest"

import { BinaryFSTMatcher } from "#fst/binary-matcher"
import { deserializeFST } from "#fst/serialize"

import { expectMatcherParity } from "../../test/fst-parity.ts"

const FST_PATH = resolvePackagePath("@mailwoman/neural-weights-en-us", "fst-en-us.bin")

describe.skipIf(!(await pathExists(FST_PATH)))("BinaryFSTMatcher over the en-US gazetteer", () => {
	test("answers like the object matcher in every state", async () => {
		const bytes = await readLocalBuffer(FST_PATH)
		const reference = deserializeFST(bytes)
		const compared = expectMatcherParity(reference, new BinaryFSTMatcher(bytes), ["zzzz-absent", "Springfield"])

		expect(compared.states).toBe(bytes.readUInt32LE(8))
		expect(compared.edges).toBe(bytes.readUInt32LE(12))
	}, 600_000)
})
