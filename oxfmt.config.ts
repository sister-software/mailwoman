/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file oxfmt configuration for the Mailwoman monorepo.
 */

import { sisterSoftwareOxfmtConfig } from "@sister.software/oxfmt-config"
import type { OxfmtConfig } from "oxfmt"

const config: OxfmtConfig = {
	...sisterSoftwareOxfmtConfig,
	jsdoc: {
		...(sisterSoftwareOxfmtConfig.jsdoc as Record<string, unknown>),
		// `mailwoman/comment-reflow` decides where a comment breaks, and oxfmt's default `greedy` re-wrapped every
		// block it touched back to the print width, which is the layout the rule exists to replace.
		//
		// `balance` keeps the breaks it is given as long as every line fits, so the two agree instead of taking turns.
		// Tag canonicalisation, ordering and the blank line before `@returns` still come from here.
		lineWrappingStyle: "balance",
	},
}

export default config
