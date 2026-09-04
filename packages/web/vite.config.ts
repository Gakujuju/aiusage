import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    proxy: {
      // Overridable so a preview can point at a throwaway serve instead of
      // the real one - the real one asks for a login, and a scratch copy of
      // the data is the right thing to draw pictures against anyway.
      '/api': process.env.AIUSAGE_API ?? 'http://localhost:3847',
    },
  },
});
