// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Ambient declarations for the stylesheet side-effect imports the browser-mode test setup makes.
 *   Vite resolves them at runtime; TypeScript needs to be told they exist, or the setup file cannot be
 *   type-checked at all.
 */

declare module "*.css" {
	const classes: Record<string, string>
	export default classes
}
