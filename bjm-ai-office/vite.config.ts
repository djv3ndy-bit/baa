import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],build:{outDir:'dist',emptyOutDir:true,rollupOptions:{input:'index.html',output:{entryFileNames:'assets/office.js',chunkFileNames:'assets/[name]-[hash].js',assetFileNames:(asset)=>asset.names.some(name=>name.endsWith('.css'))?'assets/office.css':'assets/[name]-[hash][extname]'}}}});
