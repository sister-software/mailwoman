// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The package entry: a declarative recognition engine for the formal languages in geographic queries.
 *
 *   No setup is required.
 *   An import does no WebAssembly work.
 *
 *   The first recognition instantiates the embedded engine binary synchronously.
 *
 *   Call `init` only to preload the engine or to supply a binary where synchronous compilation is refused.
 *   Compose the families an application needs with `createRecognizer`; each family is its own module,
 *   such as `@mailwoman/recognize/coordinates`, so a bundle holds only the artifacts it imports.
 *
 *   The `workerd` export condition resolves to `workerd.ts`, which imports the
 *   `.wasm` file instead of embedding it.
 */

import { embeddedWasmBytes } from "#embedded.generated"
import { setDefaultSource } from "#runtime/state"

setDefaultSource(embeddedWasmBytes)

export * from "#exports"

/**
 * The IR format identity the generator checks the Rust writer against.
 */
export { IR_FORMAT, IR_VERSION } from "#ir"
