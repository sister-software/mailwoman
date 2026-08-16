// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { Meta, StoryObj } from "@storybook/react-vite"

import { LoadingIndicator } from "./LoadingIndicator.tsx"

const meta: Meta<typeof LoadingIndicator> = {
	title: "Common/LoadingIndicator",
	component: LoadingIndicator,
}

export default meta

type Story = StoryObj<typeof LoadingIndicator>

export const Spinner: Story = { args: { mode: "spinner", label: "Loading…" } }

export const Pulse: Story = { args: { mode: "pulse", barCount: 4 } }

export const Staged: Story = {
	args: {
		mode: "staged",
		steps: ["Analyzing input shape…", "Running neural classifier…", "Resolving in gazetteer…"],
		activeStep: 1,
	},
}
