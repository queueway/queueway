/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    // Proxy API calls to the Queueway core server (running on :3000)
    return [
      {
        source: '/queueway/:path*',
        destination: `${process.env.QUEUEWAY_API_URL || 'http://localhost:3000'}/queueway/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
