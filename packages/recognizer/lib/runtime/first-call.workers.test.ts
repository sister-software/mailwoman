// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Under the Workers runtime the `workerd` entry instantiates the imported `.wasm`
 *   module on the first call, with no `init`.
 *
 *   Workers refuse to compile WebAssembly from bytes.
 *   The entry therefore imports the file.
 *
 *   Run with `yarn workspace @mailwoman/recognizer test:workers`.
 */

import { createRecognizer } from "@mailwoman/recognizer"
import { coordinates } from "@mailwoman/recognizer/coordinates"
import { expect, it } from "vitest"

import { wasm } from "#runtime/webassembly"

it("instantiates the imported module synchronously on the first call", () => {
	const recognizer = createRecognizer([coordinates])
	const { recognitions } = recognizer.recognize("at 40.7128, -74.0060")

	expect(recognitions).toHaveLength(1)
	expect(recognitions[0]).toMatchObject({ start: 3, end: 20, text: "40.7128, -74.0060" })
})

it("runs in a runtime that refuses to compile WebAssembly from bytes", () => {
	// The smallest valid module: the magic number and the version.
	const compile = () => new wasm.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))

	expect(compile).toThrow(/disallowed|not allowed|code generation/iu)
})
