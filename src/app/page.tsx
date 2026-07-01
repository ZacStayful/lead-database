import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Check, MapPin, ShieldCheck, Zap } from "lucide-react";

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-background">
      {/* Nav */}
      <header className="border-b-[0.5px] border-border">
        <div className="container flex h-16 items-center justify-between">
          <span className="text-lg font-bold text-brand">Stayful</span>
          <nav className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/login">Log in</Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/signup">Apply for access</Link>
            </Button>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="container py-24 text-center">
        <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
          Warm landlord leads. No ad spend required.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
          Stayful shares pre-screened landlord enquiries with a small number of
          STR operators each month. £300 per month. 20 leads. No contracts.
        </p>
        <div className="mt-8 flex justify-center">
          <Button size="lg" asChild>
            <Link href="/signup">Apply for access</Link>
          </Button>
        </div>
      </section>

      {/* Features */}
      <section className="container pb-20">
        <div className="grid gap-6 sm:grid-cols-3">
          {[
            {
              icon: MapPin,
              title: "Google-sourced intent leads",
              body: "Landlords actively searching for management — not cold lists.",
            },
            {
              icon: ShieldCheck,
              title: "Pre-screened by Stayful",
              body: "Every enquiry is qualified by our team before you receive it.",
            },
            {
              icon: Zap,
              title: "Ready to contact immediately",
              body: "Full property details and contact info, ready the moment they land.",
            },
          ].map((f) => (
            <Card key={f.title}>
              <CardContent className="pt-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-brand/10 text-brand">
                  <f.icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="container pb-24">
        <Card className="mx-auto max-w-lg">
          <CardContent className="pt-8 text-center">
            <p className="text-sm font-medium text-muted-foreground">
              Simple monthly pricing
            </p>
            <p className="mt-2 text-5xl font-bold">
              £300
              <span className="text-lg font-normal text-muted-foreground">
                {" "}
                / month
              </span>
            </p>
            <ul className="mx-auto mt-6 max-w-xs space-y-3 text-left text-sm">
              {[
                "20 leads included every month",
                "Overflow at £20 per lead for opted-in customers",
                "Maximum 2 operators per lead",
                "No contracts — cancel anytime",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <Button size="lg" className="mt-8 w-full" asChild>
              <Link href="/signup">Apply for access</Link>
            </Button>
          </CardContent>
        </Card>
      </section>

      <footer className="border-t-[0.5px] border-border">
        <div className="container flex h-16 items-center justify-between text-sm text-muted-foreground">
          <span>© {new Date().getFullYear()} Stayful</span>
          <Link href="/login" className="hover:text-foreground">
            Customer login
          </Link>
        </div>
      </footer>
    </main>
  );
}
