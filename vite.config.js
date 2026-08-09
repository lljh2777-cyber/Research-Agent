import { defineConfig } from 'vite'

import { createProviderApiMiddleware } from './server/provider-api.mjs'
import { createMcpApiMiddleware } from './server/mcp-api.mjs'
import { createRuntimeApiMiddleware } from './server/runtime-api.mjs'
import { createResearchRunApiMiddleware } from './server/research-run-api.mjs'

const mcpApi = createMcpApiMiddleware()
const researchRunApi = createResearchRunApiMiddleware()

export default defineConfig({
  plugins: [{
    name: 'bioresearch-provider-api',
    configureServer(server) {
      server.middlewares.use(createRuntimeApiMiddleware())
      server.middlewares.use(researchRunApi)
      server.middlewares.use(mcpApi)
      server.middlewares.use(createProviderApiMiddleware())
      server.httpServer?.once('close', () => void mcpApi.runtime.shutdown())
    },
  }],
})
