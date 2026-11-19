/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_BACKEND_URL: process.env.NEXT_PUBLIC_BACKEND_URL || '',
  },
  async rewrites() {
    const backendUrl =
      process.env.BACKEND_PROXY_URL ||
      process.env.NEXT_PUBLIC_BACKEND_URL ||
      'http://localhost:4000';

    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
      {
        source: '/health',
        destination: `${backendUrl}/health`,
      },
    ];
  },
};

module.exports = nextConfig;
