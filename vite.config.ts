import { defineConfig } from 'vite';
import { vibegame, consoleForwarding } from 'vibegame/vite';

export default defineConfig({
  plugins: [vibegame(), consoleForwarding()],
  server: {
    port: 3000,
    open: true,
    // The builder's AI assistant talks to local Ollama through the dev
    // server, so the browser never fights CORS.
    proxy: {
      '/ollama': {
        target: 'http://localhost:11434',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ollama/, ''),
      },
    },
  },
  build: {
    target: 'esnext',
    sourcemap: true,
  },
});
