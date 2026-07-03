"use client";

function MaskedValue({ masked }: { masked: string }) {
  return (
    <span className="relative inline-flex items-center">
      <span className="tracking-wide text-[#1a1a19]">{masked}</span>
      <span className="ml-2 text-xs text-[#5D8156]">Unlock on subscription</span>
    </span>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs text-[#898781]">{label}</div>
      <div className="text-[#1a1a19]">{children}</div>
    </div>
  );
}

export function LeadCardSample() {
  return (
    <div className="rounded-xl border border-l-4 border-black/10 border-l-[#5D8156] bg-white p-6">
      {/* Top row: badge + date */}
      <div className="flex items-center justify-between">
        <span className="rounded-full bg-[#EAF3DE] px-2 py-0.5 text-xs text-[#3B6D11]">
          New lead
        </span>
        <span className="text-xs text-[#898781]">3 Jul 2026</span>
      </div>

      {/* Lead name */}
      <div className="mt-3 text-base font-medium text-[#1a1a19]">
        Sarah Mitchell
      </div>

      {/* Detail grid */}
      <div className="mt-3 grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <Field label="Address">3-bed terraced, Darlington, County Durham</Field>
        <Field label="Estimated monthly income">£1,890</Field>
        <Field label="Bedrooms">3</Field>
        <Field label="Enquiry date">3 Jul 2026</Field>
        <Field label="Phone">
          <MaskedValue masked="07███ ██████" />
        </Field>
        <Field label="Email">
          <MaskedValue masked="s.mitchell@███████.com" />
        </Field>
      </div>

      {/* Lead profile */}
      <div className="mt-4">
        <div className="text-xs text-[#898781]">Lead profile</div>
        <p className="mt-1 text-sm leading-relaxed text-[#52514e]">
          Currently renting long-term at £750/month. Mortgage of £420/month on
          the property. Has enquired previously about holiday letting but
          didn&apos;t proceed. Interested in STR but wants reassurance about void
          periods and management reliability. Two Airbnb stays as a guest.
        </p>
      </div>
    </div>
  );
}
