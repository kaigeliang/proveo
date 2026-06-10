import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:5001';

const backendProxy = {
  '/api': apiProxyTarget,
  '/generated': apiProxyTarget,
  '/uploads': apiProxyTarget,
  '/objects': apiProxyTarget,
  '/reference-videos': apiProxyTarget,
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: '::',
    proxy: backendProxy,
  },
  preview: {
    host: '::',
    port: 5173,
    proxy: backendProxy,
  },
});
