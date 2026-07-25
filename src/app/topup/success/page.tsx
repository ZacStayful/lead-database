import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

/**
 * Landing page after the hosted-Checkout fallback completes. The leads are
 * credited by the Stripe webhook (checkout.session.completed), so this page is
 * purely a confirmation — it does not itself add balance.
 */
export default function TopupSuccessPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-md rounded-xl border border-black/10 bg-white p-8">
        <Link
          href="/"
          aria-label="Stayful home"
          className="mb-6 flex justify-center"
        >
          <Logo height={36} priority />
        </Link>
        <h1 className="mb-3 text-center text-lg font-semibold text-[#1a1a19]">
          Payment received
        </h1>
        <p className="mb-6 text-center text-sm leading-relaxed text-[#52514e]">
          Thank you — your top-up is confirmed. Your new leads will appear in your
          balance within a moment.
        </p>
        <Button asChild className="w-full">
          <Link href="/dashboard">Go to your dashboard</Link>
        </Button>
      </div>
    </main>
  );
}
