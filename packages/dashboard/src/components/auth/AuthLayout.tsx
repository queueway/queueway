import { Card, CardContent } from '@/components/ui/card';
import { ThemeToggle } from '@/components/ThemeToggle';
import { PoweredByFooter } from '@/components/PoweredByFooter';

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <main className="relative flex min-h-screen items-center justify-center p-4 sm:p-6">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-2 flex justify-center">
          <img src="/logo.svg" alt="Queueway" className="h-24 w-auto" />
        </div>
        <div className="mb-6 text-center text-lg font-semibold tracking-tight">
          <span className="bg-gradient-to-r from-orange-500 via-purple-500 to-blue-500 bg-clip-text text-transparent">
            Queueway
          </span>
        </div>
        <Card>
          <CardContent className="p-6">
            <h1 className="mb-1 text-lg font-semibold">{title}</h1>
            {subtitle && <p className="mb-4 text-sm text-muted-foreground">{subtitle}</p>}
            {children}
          </CardContent>
        </Card>
        <PoweredByFooter />
      </div>
    </main>
  );
}
