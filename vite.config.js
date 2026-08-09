import { defineConfig } from 'vite'

import { createProviderApiMiddleware } from './server/provider-api.mjs'
import { createMcpApiMiddleware } from './server/mcp-api.mjs'
import { createLocalWebRuntimeManifest, createRuntimeApiMiddleware, createViteWebRuntimeManifest } from './server/runtime-api.mjs'
import { createResearchRunApiMiddleware } from './server/research-run-api.mjs'

export default defineConfig(({ mode }) => {
  const runtimeManifest = mode === 'local-runtime'
    ? createLocalWebRuntimeManifest()
    : createViteWebRuntimeManifest()
  const mcpApi = createMcpApiMiddleware()
  const researchRunApi = createResearchRunApiMiddleware()

  return {
    plugins: [{
      name: 'bioresearch-provider-api',
      configureServer(server) {
        server.middlewares.use(createRuntimeApiMiddleware({ manifest: runtimeManifest }))
        server.middlewares.use(researchRunApi)
        server.middlewares.use(mcpApi)
        server.middlewares.use(createProviderApiMiddleware())
        server.httpServer?.once('close', () => void mcpApi.runtime.shutdown())
      },
    }],
  }
})
