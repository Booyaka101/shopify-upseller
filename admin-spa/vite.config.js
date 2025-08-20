import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

// Build directly into backend static so FastAPI can serve without extra config
export default defineConfig(({ mode }) => {
  const isProd = mode === 'production'
  return {
    plugins: [react()],
    build: {
      outDir: '../static/admin-spa',
      emptyOutDir: true,
    },
    base: isProd ? '/static/admin-spa/' : '/',
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:8000',
          changeOrigin: true,
          secure: false,
        },
        '/shopify': {
          target: 'http://localhost:8000',
          changeOrigin: true,
          secure: false,
        },
        '/static': {
          target: 'http://localhost:8000',
          changeOrigin: true,
          secure: false,
        },
        '/favicon.ico': {
          target: 'http://localhost:8000',
          changeOrigin: true,
          secure: false,
        },
        '/admin': {
          target: 'http://localhost:8000',
          changeOrigin: true,
          secure: false,
        },
        '/admin-legacy': {
          target: 'http://localhost:8000',
          changeOrigin: true,
          secure: false,
        },
        '/admin-spa': {
          target: 'http://localhost:8000',
          changeOrigin: true,
          secure: false,
        },
      },
    },
  }
})
