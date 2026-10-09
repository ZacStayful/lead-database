import Link from "next/link";
import { Button } from "@/components/ui/button";
import { FUNNEL_COPY } from "@/lib/funnel/copy";

/**
 * Offered to a funnel customer who signed in by magic link and has not set a
 * password (batch 02 Phase 5, C2). /reset-password works for a signed-in
 * customer, and stamps password_set_at when it succeeds, which takes this
 * card away. Shown by `offerSetPassword`.
 */
export function SetPasswordCard() {
  return (
    <div className="rounded-xl border-[0.5px] border-brand/40 bg-brand/5 p-5">
      <h2 className="text-base font-semibold">{FUNNEL_COPY.setPasswordTitle}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{FUNNEL_COPY.setPasswordBody}</p>
      <Button asChild className="mt-3 h-[38px] rounded-lg bg-brand font-semibold text-white hover:bg-brand-dark">
        <Link href="/reset-password">{FUNNEL_COPY.setPasswordButton}</Link>
      </Button>
    </div>
  );
}
