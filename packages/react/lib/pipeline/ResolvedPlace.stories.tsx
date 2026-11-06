// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { Meta, StoryObj } from "@storybook/react-vite"

import { ResolvedPlace } from "./ResolvedPlace.tsx"

const meta: Meta<typeof ResolvedPlace> = {
	title: "Pipeline/ResolvedPlace",
	component: ResolvedPlace,
	args: {
		place: { id: 85_977_539, name: "New York", placetype: "locality", lat: 40.7128, lon: -74.006, score: 0.82 },
	},
}

export default meta

type Story = StoryObj<typeof ResolvedPlace>

export const Default: Story = {}
