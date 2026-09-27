// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { sisterSoftwareOxfmtConfig } from "@sister.software/oxfmt-config"
import type { OxfmtConfig } from "oxfmt"

const config: OxfmtConfig = {
	...sisterSoftwareOxfmtConfig,
	// `mailwoman/comment-reflow` owns comment layout, and two formatters cannot own it at once.
	jsdoc: false,
}

export default config
