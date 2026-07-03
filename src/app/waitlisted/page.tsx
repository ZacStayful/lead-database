import Link from "next/link";
import { Logo } from "@/components/Logo";

export const dynamic = "force-dynamic";

export default function WaitlistedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-md rounded-xl border border-black/10 bg-white p-8">
        <Link href="/" aria-label="Stayful home" className="mb-6 flex justify-center">
          <Logo height={36} priority />
        </Link>
        <h1 className="mb-3 text-center text-lg font-semibold text-[#1a1a19]">
          Your account has been created.
        </h1>
        <p className="text-sm leading-relaxed text-[#52514e]">
          We have reached our current subscriber limit and are managing capacity
          carefully to ensure lead quality for all operators. You are on our
          waitlist and will receive an email the moment a place becomes available.
        </p>
        <p className="mt-4 text-sm leading-relaxed text-[#52514e]">
          There is nothing further you need to do.
        </p>
      </div>
    </main>
  );
}
