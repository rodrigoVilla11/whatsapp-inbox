import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Deploy en contenedor (fase 10c): server.js autocontenido + estáticos,
  // sin node_modules completos en la imagen final.
  output: 'standalone',
};

export default nextConfig;
