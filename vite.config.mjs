import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Strict policy for the packaged app. The interface may only load its own files;
// remote images are possible only inside an email the reader chose to trust.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: http:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'self' about:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const contentSecurityPolicy = {
  name: 'emargy-content-security-policy',
  apply: 'build',
  transformIndexHtml(html) {
    return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`);
  },
};

export default defineConfig({
  plugins: [react(), contentSecurityPolicy],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    include: ['tests/**/*.test.js'],
    testTimeout: 20000,
  },
});
