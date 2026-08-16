// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { Meta, StoryObj } from "@storybook/react-vite"

import { CopyButton } from "./CopyButton.tsx"

const meta: Meta<typeof CopyButton> = {
	title: "Common/CopyButton",
	component: CopyButton,
}

export default meta

type Story = StoryObj<typeof CopyButton>

export const Default: Story = { args: { value: "copied text" } }

export const CustomLabels: Story = { args: { value: "x", label: "Copy JSON", copiedLabel: "✓ Copied" } }
