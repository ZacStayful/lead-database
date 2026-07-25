import Link from "next/link";
import { Logo } from "@/components/Logo";
import { createAdminClient } from "@/lib/supabase/admin";
import { describeTopupToken, productLabel } from "@/lib/topup";
import { TopupConfirm } from "./TopupConfirm";

export const dynamic = "force-dynamic";

/** Format an integer pence amount as GBP, dropping ".00" for whole pounds. */
function formatGbp(pence: number): string {
  const pounds = pence / 100;
  return Number.isInteger(pounds) ? `£${pounds}` : `£${pounds.toFixed(2)}`;
}

function Shell({ children }: { children: React.ReactNode }) {
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
        {children}
      </div>
    </main>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <>
      <h1 className="mb-3 text-center text-lg font-semibold text-[#1a1a19]">
        {title}
      </h1>
      <p className="text-center text-sm leading-relaxed text-[#52514e]">{body}</p>
    </>
  );
}

export default async function TopupPage({
  params,
}: {
  params: { token: string };
}) {
  const supabase = createAdminClient();
  const view = await describeTopupToken(supabase, params.token);

  if (view.status === "invalid") {
    return (
      <Shell>
        <Message
          title="This link isn't valid"
          body="We couldn't find this top-up link. Please check you've opened the most recent message, or contact support."
        />
      </Shell>
    );
  }

  if (view.status === "expired") {
    return (
      <Shell>
        <Message
          title="This link has expired"
          body="Top-up links are valid for 48 hours. Your next assigned lead will generate a fresh link the moment your balance is empty."
        />
      </Shell>
    );
  }

  if (view.status === "paid") {
    return (
      <Shell>
        <Message
          title="You're topped up"
          body="This top-up has already been paid and the leads have been added to your balance."
        />
      </Shell>
    );
  }

  if (view.status === "used") {
    return (
      <Shell>
        <Message
          title="This link has already been used"
          body="This top-up link has already been used. If you didn't complete a payment, please contact support."
        />
      </Shell>
    );
  }

  const price = formatGbp(view.amountPence);
  const label = productLabel(view.leadType);

  return (
    <Shell>
      <h1 className="mb-2 text-center text-lg font-semibold text-[#1a1a19]">
        Top up your leads
      </h1>
      <p className="mb-5 text-center text-sm leading-relaxed text-[#52514e]">
        You're out of {label} leads. Add {view.credits} more now — charged to the
        card already on file.
      </p>
      <div className="mb-6 rounded-xl border border-black/10 bg-muted/30 p-5 text-center">
        <div className="text-2xl font-semibold text-[#1a1a19]">
          {view.credits} more leads
        </div>
        <div className="mt-1 text-sm text-[#52514e]">{price} — a one-off charge</div>
      </div>
      <TopupConfirm
        token={params.token}
        credits={view.credits}
        priceLabel={price}
      />
      <p className="mt-4 text-center text-xs text-[#8a8f88]">
        Single-use link · expires 48 hours after it was sent
      </p>
    </Shell>
  );
}
