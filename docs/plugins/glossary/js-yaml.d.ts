// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Minimal ambient declaration for js-yaml (hoisted from @docusaurus/core. No @types package installed).
 *
 * Only the surface plugin.ts uses.
 */
declare module "js-yaml" {
	export function load(input: string): unknown
}
