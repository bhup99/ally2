import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev only: proxy API calls to the Express server on :3001.
// In production the server serves client/dist, so no proxy is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
