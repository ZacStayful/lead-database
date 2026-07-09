import type { Metadata } from "next";
import "./globals.css";
import { CompanyComplianceFooter } from "@/components/layout/CompanyComplianceFooter";

export const metadata: Metadata = {
  title: "Stayful — warm landlord leads",
  description:
    "Stayful shares pre-screened landlord enquiries with a small number of STR operators each month.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
        <CompanyComplianceFooter />
      </body>
    </html>
  );
}
