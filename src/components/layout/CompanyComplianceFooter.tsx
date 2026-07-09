// Static company & compliance facts. No props, no data fetching — plain text
// that renders at the bottom of every page via the root layout.
export function CompanyComplianceFooter() {
  return (
    <div className="border-t-[0.5px] border-border">
      <div className="container py-6">
        <p className="text-center text-xs leading-relaxed text-[#898781]">
          Stayful Ltd
          {" · "}
          <a
            href="https://find-and-update.company-information.service.gov.uk/company/14791583"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Company number 14791583
          </a>
          {" · "}
          Registered office: 20-22 Wenlock Road, London, England, N1 7GU
          {" · "}
          VAT: 494468833
          {" · "}
          ICO registration: ZA00016946040
          {" · "}
          Operating since 2023
        </p>
      </div>
    </div>
  );
}
