import { defineConfig } from 'vite'

import { createProviderApiMiddleware } from './server/provider-api.mjs'
import { createMcpApiMiddleware } from './server/mcp-api.mjs'

const mcpApi = createMcpApiMiddleware()

export default defineConfig({
  plugins: [{
    name: 'bioresearch-provider-api',
    configureServer(server) {
      server.middlewares.use(mcpApi)
      server.middlewares.use(createProviderApiMiddleware())
      server.httpServer?.once('close', () => void mcpApi.runtime.shutdown())
    },
  }],
})
