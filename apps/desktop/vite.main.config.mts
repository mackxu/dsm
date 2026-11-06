import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rolldownOptions: {
      external: ['@aws-sdk/client-s3'],
    },
  },
});
