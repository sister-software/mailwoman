import { previewConfig } from "@mailwoman/site-kit/playwright"

export default previewConfig({ port: 7780, remoteURLVariable: "MAILWOMAN_EARTH_URL" })
