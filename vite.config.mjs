import { createHash } from 'node:crypto';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { FRAME_REPORTER } from './src/frameReporter.js';

// The email frame's height reporter is the only inline script allowed anywhere, by hash.
const FRAME_REPORTER_HASH = `sha256-${createHash('sha256').update(FRAME_REPORTER, 'utf8').digest('base64')}`;

// Strict policy for the packaged app. The interface may only load its own files;
// remote images are possible only inside an email the reader chose to trust.
// Email frames (srcdoc) inherit this policy and add their own stricter one.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' '${FRAME_REPORTER_HASH}'`,
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
  define: {
    __FRAME_REPORTER_HASH__: JSON.stringify(FRAME_REPORTER_HASH),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    include: ['tests/**/*.test.js'],
    testTimeout: 20000,
  },
});
