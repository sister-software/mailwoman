/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Docusaurus client module registering the site's Trusted Types policies at boot, so every policy
 *   name exists before any sink asks for one and a CSP `trusted-types` directive can enumerate them.
 *   Client modules also evaluate during server rendering, where no DOM exists and the sanitizer-backed
 *   policies must not be minted — hence the environment guard rather than a bare call.
 */

import ExecutionEnvironment from "@docusaurus/ExecutionEnvironment"
import { registerTrustPolicies } from "@mailwoman/react/trust-policies"

if (ExecutionEnvironment.canUseDOM) {
	registerTrustPolicies()
}
