import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Deploy en contenedor (fase 10c): server.js autocontenido + estáticos,
  // sin node_modules completos en la imagen final.
  output: 'standalone',
  // Integración Gourmetify: el inbox vive bajo <dominio>/inbox (ruteo por
  // path en el proxy). Debe coincidir con BASE_PATH de src/lib/api.ts.
  basePath: '/inbox',
};

export default nextConfig;
