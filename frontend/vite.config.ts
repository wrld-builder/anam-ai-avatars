// frontend/vite.config.ts
import { defineConfig } from 'vite'

// frontend/vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      '/api':      { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/anam/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    }
  }
})

