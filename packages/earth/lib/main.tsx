/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createRoot } from "react-dom/client"
import { registerSW } from "virtual:pwa-register"

registerSW()

const root = document.getElementById("root")

if (!root) throw new Error("index.html has no #root")

createRoot(root).render(<p>Mailwoman Earth</p>)
