export const metadata = {
  title: 'Webhook Processor - Operations',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: '20px', background: '#f5f5f5' }}>
        {children}
      </body>
    </html>
  );
}
