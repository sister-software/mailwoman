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
	// `mailwoman/comment-reflow` owns comment layout, and two formatters cannot own it at once.
	//
	// `lineWrappingStyle: "balance"` came close: oxfmt kept the breaks it was given
	// as long as every line in the block fitted.
	// One line over the print width — an identifier, a URL, a CJK run with nowhere to break —
	// and it re-filled the whole block greedily, and the rule reported it again on the next run.
	// A block a rule can never satisfy is a lint error with no fix.
	//
	// What this gives up is oxfmt's tag work: canonical aliases, capitalised descriptions,
	// the blank line before `@returns`.
	// Nothing reformats those now, so they hold where this branch left them.
	jsdoc: false,
}

export default config
