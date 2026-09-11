import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  base: '/command/',
  plugins: [vue()],
  server: { proxy: { '/command/api': 'http://127.0.0.1:3050' } },
});
