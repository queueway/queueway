/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: `next build` produces plain HTML/CSS/JS in ./out,
  // which gets bundled into packages/core/public and served automatically
  // by `queueway start` — no separate dashboard server/port needed.
  output: 'export',

  async rewrites() {
    // Only used during local dashboard development (`npm run dev`), so you
    // can iterate on the UI against a running `queueway start` on :4287
    // without CORS issues. Ignored during static export builds.
    return [
      {
        source: '/queueway/:path*',
        destination: `${process.env.QUEUEWAY_API_URL || 'http://localhost:4287'}/queueway/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
