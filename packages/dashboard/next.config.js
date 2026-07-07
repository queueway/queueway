/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    // Proxy API calls to the QueueKit core server (running on :3000)
    return [
      {
        source: '/queuekit/:path*',
        destination: `${process.env.QUEUEKIT_API_URL || 'http://localhost:3000'}/queuekit/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
