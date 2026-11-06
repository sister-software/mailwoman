// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Declarations for the parts of `@journeyapps/wa-sqlite` its own `src/types/index.d.ts` leaves undeclared: the JSPI
 *   build's loader, the `FacadeVFS` base class, and a bundled `.wasm` import. Wrangler supplies that import as a
 *   compiled `WebAssembly.Module`.
 */

declare module "@journeyapps/wa-sqlite/dist/wa-sqlite-jspi.mjs" {
	export default function ModuleFactory(config?: object): Promise<object>
}

declare module "@journeyapps/wa-sqlite/dist/wa-sqlite-jspi.wasm" {
	const module: WebAssembly.Module
	export default module
}

declare module "@journeyapps/wa-sqlite/src/FacadeVFS.js" {
	import type { Base } from "@journeyapps/wa-sqlite/src/VFS.js"

	export class FacadeVFS extends Base {
		constructor(name: string, module: object)
		jOpen(filename: string | null, pFile: number, flags: number, pOutFlags: DataView): number | Promise<number>
		jRead(pFile: number, pData: Uint8Array, iOffset: number): number | Promise<number>
		jFileSize(pFile: number, pSize64: DataView): number | Promise<number>
		jAccess(filename: string, flags: number, pResOut: DataView): number | Promise<number>
		jDeviceCharacteristics(pFile: number): number
	}
}
