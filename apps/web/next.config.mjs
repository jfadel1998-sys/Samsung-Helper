/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript source, not build output.
  transpilePackages: [
    '@hub/brief',
    '@hub/config',
    '@hub/connectors',
    '@hub/crypto',
    '@hub/db',
    '@hub/extraction',
    '@hub/jobs',
  ],
  serverExternalPackages: ['pg-boss', 'postgres'],
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
};

export default nextConfig;
