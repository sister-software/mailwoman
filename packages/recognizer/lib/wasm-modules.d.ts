// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * A `.wasm` file as a Workers runtime supplies it: a compiled module, imported by the `workerd` entry.
 */
declare module "*.wasm" {
	import type { CompiledModule } from "#runtime/webassembly"

	const compiled: CompiledModule

	export default compiled
}
