import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import { Providers } from '@/components/ui/Providers';

export const metadata: Metadata = {
  title: 'RoofOps · Operations Control Centre',
  description: 'Operations control centre for a roofing business (demo environment, synthetic data).',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
