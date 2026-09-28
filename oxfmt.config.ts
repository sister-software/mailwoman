/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { sisterSoftwareOxfmtConfig } from "@sister.software/oxfmt-config"
import type { OxfmtConfig } from "oxfmt"

const config: OxfmtConfig = {
	...sisterSoftwareOxfmtConfig,
	// `mailwoman/comment-reflow` owns comment layout.
	// Two formatters cannot own it at once.
	jsdoc: false,
}

export default config
