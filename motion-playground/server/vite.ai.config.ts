import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config';
import { aiBridge } from './ai-bridge';

export default mergeConfig(base, defineConfig({
  plugins: [aiBridge()],
  server: { port: 5196, strictPort: true, open: false }
}));
