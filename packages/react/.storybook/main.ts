// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Storybook (Vite builder) for `@mailwoman/react`. Renders the extracted explorers + their leaf
 *   presentational units in isolation — outside Docusaurus/ONNX/httpvfs — which is what proves they
 *   are Docusaurus-independent. Mirrors the docs workspace's Storybook setup.
 */

import type { StorybookConfig } from "@storybook/react-vite"
import react from "@vitejs/plugin-react"

const config: StorybookConfig = {
	stories: ["../**/*.stories.@(ts|tsx)"],
	addons: ["@storybook/addon-docs"],
	framework: {
		name: "@storybook/react-vite",
		options: {},
	},
	core: {
		disableTelemetry: true,
	},
	typescript: {
		reactDocgen: "react-docgen-typescript",
	},
	viteFinal: (viteConfig) => {
		viteConfig.plugins = [...(viteConfig.plugins ?? []), react()]

		return viteConfig
	},
}

export default config
