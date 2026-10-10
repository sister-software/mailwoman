import { previewConfig } from "@mailwoman/universe/site-kit/playwright"

// The preview serves on port 7772.
// The Earth and planetary previews use 7771, and the docs dev server uses 7770.
// The application has no deployment, so the specs run against the preview server
// unless MAILWOMAN_OPPORTUNITY_APP_URL names another one.
export default previewConfig({ port: 7772, remoteURLVariable: "MAILWOMAN_OPPORTUNITY_APP_URL" })
