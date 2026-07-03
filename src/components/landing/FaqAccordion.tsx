"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const FAQS: { q: string; a: string }[] = [
  {
    q: "Are these genuinely interested landlords or just anyone who filled in a form?",
    a: "Every lead comes from an organic Google search for STR property management followed by a completed enquiry form. The landlord has actively sought out a management company. Before reaching you, each lead is run through a financial model comparing projected STR income against their current arrangement. Leads available in the marketplace typically show a positive financial case for STR. These are not scraped lists or cold contacts — they are people who went looking for what you do.",
  },
  {
    q: "What happens if I receive a poor-quality lead?",
    a: "Every lead is delivered with the full information Stayful received — name, address, phone, email, bedroom count, estimated monthly income, and a lead profile written from the enquiry conversation. If a lead's contact details are factually incorrect (wrong number, bounced email), contact Zac directly and it will be reviewed. Leads that simply don't convert are not refundable — lead generation is a volume and consistency game, and the 5% conversion rate is a long-run average across more than 1,100 enquiries, not a per-lead guarantee.",
  },
  {
    q: "Can I cancel? Is there a minimum commitment?",
    a: "Cancel anytime from your account settings. There is no minimum term and no cancellation penalty. If your monthly lead allocation is not met in any billing period, the shortfall carries forward to the following month — you will always receive the leads you have paid for.",
  },
  {
    q: "What if another subscriber in my city receives the same lead?",
    a: "Each lead is assigned to a maximum of two operators simultaneously. If you are the only subscriber covering a particular area, you will receive those leads exclusively. The system does not filter leads by geography — you decide which leads to pursue. If a lead is in a city you don't cover, you simply don't follow up. You are charged per lead received, not per lead pursued.",
  },
  {
    q: "How is this different from running my own Google Ads?",
    a: "A Google Ads click on a property management keyword in a competitive UK city costs £8–25. That is a click — not a name, a phone number, or a conversation. A completed enquiry form with contact details, property address, bedroom count, and estimated income takes significantly more than one click to generate. At £15 per completed, financially modelled enquiry, the Stayful Lead Marketplace provides the output of a Google Ads campaign without requiring you to build, manage, or optimise one.",
  },
];

export function FaqAccordion() {
  return (
    <Accordion type="single" collapsible className="w-full">
      {FAQS.map((item, i) => (
        <AccordionItem key={i} value={`item-${i}`}>
          <AccordionTrigger className="text-sm font-medium text-[#1a1a19]">
            {item.q}
          </AccordionTrigger>
          <AccordionContent className="text-sm leading-relaxed text-[#52514e]">
            {item.a}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
