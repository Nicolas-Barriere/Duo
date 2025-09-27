import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-dvh bg-neutral-950 text-neutral-100 antialiased">
        {children}
      </body>
    </html>
  );
}