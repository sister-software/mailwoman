// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { defineConfig } from "vitest/config"

/**
 * Configures Vitest to run the package's `*.node.test.ts` files under plain Node,
 * outside the browser-mode config, to show those modules need no DOM or WebGL.
 */
export default defineConfig({
	test: {
		environment: "node",
		include: ["**/*.node.test.ts"],
	},
})
