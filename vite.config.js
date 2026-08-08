import { defineConfig } from 'vite'

import { createProviderApiMiddleware } from './server/provider-api.mjs'

export default defineConfig({
  plugins: [{
    name: 'bioresearch-provider-api',
    configureServer(server) {
      server.middlewares.use(createProviderApiMiddleware())
    },
  }],
})
