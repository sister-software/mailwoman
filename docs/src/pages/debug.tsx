/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `/debug` — the geocoder demo with the model-visualizer drawer open by default. Same client-side
 *   stack as `/demo`; the drawer traces the SAME address you geocode on the map (tokens, retrieval
 *   channels, emissions, priors, repairs) so a lever's effect is visible in place. A dev/inspection
 *   surface, not a separate app — it reuses the demo body wholesale via {@link DemoPageInner}.
 */

import type React from "react"

import { DemoPageInner } from "./demo/index.tsx"

const DebugPage: React.FC = () => <DemoPageInner debugDefault />

export default DebugPage
