import type { NextConfig } from 'next';

const config: NextConfig = {
  serverExternalPackages: ['pg'],
  poweredByHeader: false,
  devIndicators: false,
  turbopack: { root: import.meta.dirname },
};
export default config;
