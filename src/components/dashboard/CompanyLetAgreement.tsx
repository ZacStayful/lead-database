import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";

/**
 * Company let tenancy agreement resource for Guaranteed Rent subscribers.
 *
 * Renders a download button for the ready-to-sign company letting agreement,
 * with an FAQ underneath that summarises the agreement's terms — what the
 * landlord is responsible for and what the tenant (the operator's company) is
 * responsible for. The summary is derived from the agreement itself and is not
 * legal advice.
 */

const AGREEMENT_URL = "/company-let-tenancy-agreement.docx";

const FAQ: { q: string; a: string }[] = [
  {
    q: "What kind of agreement is this?",
    a: "A company letting agreement. The property is let to your company rather than to an individual, so it is a company let and sits outside the assured-tenancy rules of the Housing Act 1988. Your company holds the tenancy and places Approved Occupiers in the property under licence. It is intended for fixed terms of up to three years.",
  },
  {
    q: "What is the landlord responsible for?",
    a: "Keeping the structure and exterior in repair and the water, gas, electricity and heating installations in working order (section 11, Landlord and Tenant Act 1985); allowing your company quiet enjoyment of the property; giving at least 24 hours' written notice before inspecting (except in an emergency); and only repossessing through a court order. If the property is made uninhabitable by an insured risk such as fire or flood that your side did not cause, the agreement ends and any rent paid in advance for the remaining period is refunded.",
  },
  {
    q: "What is your company (the tenant) responsible for?",
    a: "Paying the rent in advance and the council tax and utility bills; keeping the interior clean and in good repair with fair wear and tear excepted, and paying for any damage caused by occupiers or visitors; maintaining any gardens, testing smoke and carbon monoxide alarms and replacing bulbs and fuses; keeping the property free of pests; not altering locks or making alterations without written consent; and returning the property clean, with vacant possession and all keys, at the end of the term.",
  },
  {
    q: "Who actually lives in the property?",
    a: "Approved Occupiers appointed by your company and approved in writing by the landlord. They occupy as licensees, not as tenants, so no separate tenancy is created in their name. You may change the occupier during the term but must tell the landlord, and you must carry out Right to Rent checks under the Immigration Act 2014.",
  },
  {
    q: "How does the deposit work?",
    a: "A deposit is held as security for your company's obligations and to cover the reasonable cost of any breach. Because this is a company let, it is not protected under the statutory tenancy deposit scheme (Housing Act 2004). The balance is returned after the tenancy ends, less any reasonable costs incurred.",
  },
  {
    q: "How and when can the tenancy end?",
    a: "It runs for the agreed fixed term. If it continues as a periodic tenancy afterwards, either party must give at least 28 days' (or one month's) written notice. The landlord can only repossess with a court order, and the forfeiture grounds are: rent unpaid within 60 days of the due date, breach of the agreement, or your company going into liquidation.",
  },
  {
    q: "Does it allow short-let / Airbnb use?",
    a: "The document is a standard company let, and its default use clauses restrict subletting, business use and paying guests. Where the property is to be run as short-let or serviced accommodation, agree that intended use in writing with the landlord and record it in the Special Conditions (First Schedule) before signing — this is what the landlords in this database have consented to.",
  },
];

export function CompanyLetAgreement() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Company let tenancy agreement</CardTitle>
        <p className="text-sm text-muted-foreground">
          A ready-to-sign company letting agreement for getting landlords onto a
          guaranteed rent arrangement. Free with your Guaranteed Rent
          subscription.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <Button asChild>
          <a href={AGREEMENT_URL} download>
            <Download className="h-4 w-4" />
            Download the agreement
          </a>
        </Button>

        <div>
          <h3 className="mb-2 text-sm font-semibold">
            Understanding the agreement
          </h3>
          <div className="divide-y divide-border rounded-lg border-[0.5px] border-border">
            {FAQ.map((item) => (
              <details key={item.q} className="group px-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-3 text-sm font-medium">
                  {item.q}
                  <span className="text-muted-foreground transition-transform group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="pb-4 text-sm text-muted-foreground">{item.a}</p>
              </details>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            This summary is provided for convenience and is not legal advice. The
            agreement is a legal document — take appropriate advice before use.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
