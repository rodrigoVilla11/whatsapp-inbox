import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import './globals.css';

/*
 * Tipografía del sistema (9a) — self-hosted vía next/font, cero CDN en
 * runtime. Plex Sans: toda la UI. Plex Mono: SOLO datos operativos
 * (countdowns, horas, teléfonos) — "si está en mono, es un dato que corre".
 */
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Inbox — Nova Sushi',
  description: 'Inbox de WhatsApp',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body className="h-full bg-ceramic font-sans text-sumi antialiased">{children}</body>
    </html>
  );
}
