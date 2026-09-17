import type { Metadata } from "next";
import "./globals.css";
import { CompanyComplianceFooter } from "@/components/layout/CompanyComplianceFooter";
import { MetaPixel } from "@/components/MetaPixel";

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
        {/* Renders nothing at all unless NEXT_PUBLIC_META_PIXEL_ID is set, and
            never on /dashboard or /admin. See src/components/MetaPixel.tsx. */}
        <MetaPixel />
        {children}
        <CompanyComplianceFooter />
      </body>
    </html>
  );
}
