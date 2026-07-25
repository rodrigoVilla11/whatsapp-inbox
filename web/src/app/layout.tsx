import type { Metadata, Viewport } from 'next';
import './globals.css';

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
    <html lang="es">
      <body className="h-full bg-stone-100 text-stone-900 antialiased">{children}</body>
    </html>
  );
}
