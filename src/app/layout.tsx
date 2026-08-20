import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Distributor OS',
  description: 'Inquiry to delivery, with less retyping',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
