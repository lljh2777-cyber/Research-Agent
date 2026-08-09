import { defineConfig } from 'vite'

import { createActionApiMiddleware } from './server/action-api.mjs'
import { createAnnotationApiMiddleware } from './server/annotation-api.mjs'
import { createProviderApiMiddleware } from './server/provider-api.mjs'
import { createMcpApiMiddleware } from './server/mcp-api.mjs'
import { createLocalWebRuntimeManifest, createRuntimeApiMiddleware, createViteWebRuntimeManifest } from './server/runtime-api.mjs'
import { createResearchRunApiMiddleware } from './server/research-run-api.mjs'

export default defineConfig(({ mode }) => {
  const localRuntime = mode === 'local-runtime'
  const runtimeManifest = localRuntime
    ? createLocalWebRuntimeManifest()
    : createViteWebRuntimeManifest()
  const mcpApi = createMcpApiMiddleware()
  const researchRunApi = createResearchRunApiMiddleware()
  const localServicesAvailable = localRuntime && runtimeManifest.capabilities.annotations.available
  const annotationApi = localServicesAvailable ? createAnnotationApiMiddleware() : null
  const actionApi = localServicesAvailable ? createActionApiMiddleware() : null

  return {
    plugins: [{
      name: 'bioresearch-provider-api',
      configureServer(server) {
        server.middlewares.use(createRuntimeApiMiddleware({ manifest: runtimeManifest }))
        if (annotationApi) server.middlewares.use(annotationApi)
        if (actionApi) server.middlewares.use(actionApi)
        server.middlewares.use(researchRunApi)
        server.middlewares.use(mcpApi)
        server.middlewares.use(createProviderApiMiddleware())
        server.httpServer?.once('close', () => void mcpApi.runtime.shutdown())
        server.httpServer?.once('close', () => actionApi?.service?.shutdown())
      },
    }],
  }
})
