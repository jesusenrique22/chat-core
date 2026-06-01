/** @type {import('next').NextConfig} */
const extraOrigins = (process.env.NEXT_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig = {
  experimental: {
    allowedDevOrigins: ['localhost', '127.0.0.1', ...extraOrigins],
  },
};

export default nextConfig;
