// STR Owner Objection Assistant — FAQ data
// Pre-loaded reference data. No backend, no API calls during use.
//
// Generic version — adapted from an internal sales objection-handling script
// for use by any STR management operator. Figures in [brackets] are
// placeholders: replace them with your own management fee, deposit amount,
// contract terms, comms channel, and case-study examples before use.
//
// tier:     1 = every meeting, 2 = most meetings, 3 = common, 4 = situational
// category: Revenue | Fees | Service | Contract | Setup | Legal & Tax | Situations
// profiles: lead profile types this answer is especially relevant to
// headline: glanceable one-line gist shown big while you keep talking
// answer:   full detail underneath
// keywords: natural phrasings a landlord actually uses — used to match typed search queries

export type TierKey = 1 | 2 | 3 | 4;
export type IntentKey = "buying" | "evaluating" | "concern";

export interface TierMeta {
  label: string;
  short: string;
  color: string;
}

export interface IntentMeta {
  label: string;
  short: string;
  color: string;
  weight: number;
}

export interface Faq {
  id: number;
  tier: TierKey;
  category: string;
  profiles: string[];
  question: string;
  headline: string;
  answer: string;
  keywords: string[];
  intent: IntentKey;
}

export const TIERS: Record<TierKey, TierMeta> = {
  1: { label: "Tier 1 · Every meeting", short: "Tier 1", color: "rgb(93,129,86)" },
  2: { label: "Tier 2 · Most meetings", short: "Tier 2", color: "#d99a2b" },
  3: { label: "Tier 3 · Common", short: "Tier 3", color: "#5a7a9a" },
  4: { label: "Tier 4 · Situational", short: "Tier 4", color: "#6b7280" },
};

export const CATEGORIES = [
  "All",
  "Revenue",
  "Fees",
  "Service",
  "Contract",
  "Setup",
  "Legal & Tax",
  "Situations",
];

// Lead profile types.
export const PROFILES = ["Buy-to-STL", "STL Switch", "Abroad", "Ex-STL"];
const ALL_PROFILES = [...PROFILES];

// The FAQ records before intent is attached. Content is verbatim from the
// reference data — do not resolve or remove the [bracketed placeholders].
const RAW_FAQS: Omit<Faq, "intent">[] = [
  {
    id: 1,
    tier: 1,
    category: "Revenue",
    profiles: ALL_PROFILES,
    question: "How much will I actually make?",
    headline: "Two figures — gross and net. The net is what matters.",
    answer:
      "We give you two figures — the gross, which is everything that comes in from guests, and the net, which is what actually lands in your bank after the platform fee, our management fee, and cleaning and running costs come out. The net is the number that matters. Year one is typically modelled conservatively — around [your Year 1 modelling %, e.g. 80%] of full run rate — while reviews build and pricing dials in; year two onwards is where properties typically settle.",
    keywords: [
      "how much will i make", "how much can i earn", "how much money",
      "what will i make", "what do i get", "income", "earnings", "profit",
      "return", "take home", "how much will it make", "what can it make",
    ],
  },
  {
    id: 2,
    tier: 1,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "What do you actually do — is it fully hands-off?",
    headline: "Fully hands-off — we run everything except your bills.",
    answer:
      "We run the entire operation for you: guest communication, booking management, check-ins and check-outs, cleaning and linen changeovers after every stay, maintenance coordination and dynamic pricing. You genuinely don’t need to do anything operationally. The only things you stay responsible for are the bills — utilities, broadband, council tax and your mortgage.",
    keywords: [
      "what do you do", "how does it work", "hands off", "hands-off",
      "do i have to do anything", "whats involved for me", "full service",
      "do you manage everything", "is it managed", "whats my involvement",
      "how much work is it for me",
    ],
  },
  {
    id: 3,
    tier: 2,
    category: "Revenue",
    profiles: ALL_PROFILES,
    question: "Why is Year 1 lower than Year 2?",
    headline: "Year 1 is modelled conservatively while reviews build.",
    answer:
      "Year one is typically projected at around [your Year 1 modelling %, e.g. 80%] of the full run rate. That’s because you’re building reviews, getting your pricing dialled in, and the listing is finding its audience. So year one is the deliberately conservative number. Year two onwards is where properties typically settle into their full run rate.",
    keywords: [
      "year one", "first year", "why is year one lower", "ramp up", "ramp-up",
      "lower at the start", "why less in the first year", "build up",
      "why is the first year less", "year two",
    ],
  },
  {
    id: 4,
    tier: 2,
    category: "Revenue",
    profiles: ALL_PROFILES,
    question: "Those numbers seem high — I’ve seen lower estimates elsewhere.",
    headline: "Live postcode data — and Year 1 is already discounted.",
    answer:
      "These are based on live market data from your specific postcode — the competing properties, current nightly rates and occupancy. We’d rather show you the real picture than an inflated number to win your business, and Year 1 is already discounted by around [your Year 1 discount %, e.g. 20%] for ramp-up. [Insert your own comparable property here — a live example showing actual vs projected figures — to show you track close to your numbers.]",
    keywords: [
      "numbers seem high", "too good to be true", "sounds optimistic",
      "seen lower", "lower estimates elsewhere", "are these realistic",
      "inflated", "that seems high", "is that realistic", "overestimating",
    ],
  },
  {
    id: 5,
    tier: 1,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "Who handles cleaning and changeovers?",
    headline: "We handle every clean and linen change — guest-funded.",
    answer:
      "We do — cleaning and linen changeovers after every single stay are part of the service. The cleaning cost is typically charged to the guest as a cleaning fee, so it’s largely self-funding and doesn’t eat into your net. You never have to arrange or chase a clean.",
    keywords: [
      "cleaning", "who cleans", "changeover", "change over", "linen",
      "laundry", "turnaround", "clean between guests", "housekeeping",
      "who does the cleaning",
    ],
  },
  {
    id: 6,
    tier: 2,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "What about maintenance and repairs?",
    headline: "We coordinate repairs — up to a threshold without calling you.",
    answer:
      "We coordinate all maintenance for you. We can authorise repairs up to [your maintenance authorisation threshold, e.g. £300] without needing to call you so small issues get fixed fast; anything above that and we come to you first. We photograph the property before and after every stay, so if there’s damage we pursue recovery through the platform’s guest protection programme or the guest’s security deposit and manage the whole claim.",
    keywords: [
      "maintenance", "repairs", "who fixes", "something breaks", "broken",
      "fix things", "handyman", "if something breaks", "repair", "plumber",
      "boiler", "who deals with repairs",
    ],
  },
  {
    id: 7,
    tier: 1,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "What about problem guests — how do you vet bookings?",
    headline: "Every guest vetted — no parties, stag or hen bookings.",
    answer:
      "Every guest is vetted before we accept the booking — ID verification, profile history and message screening. We don’t accept stag dos, hen parties or party bookings. If a guest causes any issues during a stay, we handle it — you won’t be getting calls at midnight.",
    keywords: [
      "problem guests", "bad guests", "parties", "party", "vet guests",
      "vetting", "screening", "who do you let in", "dodgy guests", "stag",
      "hen", "how do you check guests", "troublesome guests",
      "right type of guests", "getting the right type of guests",
      "wrong type of guests", "how do you screen guests",
    ],
  },
  {
    id: 8,
    tier: 1,
    category: "Revenue",
    profiles: ["Buy-to-STL", "STL Switch"],
    question: "How does short-let compare to a long let?",
    headline: "Net often beats a long let — even on a conservative Year 1.",
    answer:
      "Let’s put the two side by side. With a traditional letting agent you’re typically looking at a 10–12% agency fee, plus void periods and maintenance you cover regardless. On the short-let side, even on a conservative Year 1 projection the net is often materially higher per year, and by year two the uplift is larger again. The trade-off is it’s less predictable month to month — but the annual total, even at the conservative end, is generally the stronger outcome.",
    keywords: [
      "long let", "long term", "long-term", "versus", "compared to renting",
      "traditional let", "letting agent", "vs long term", "comparison",
      "normal rental", "assured tenancy", "instead of renting it out",
      "long term tenant",
    ],
  },
  {
    id: 9,
    tier: 2,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "Which platforms do you list on?",
    headline: "Airbnb, Booking.com and more — daily dynamic pricing.",
    answer:
      "We list across the major platforms — typically Airbnb and Booking.com — and [mention any direct-booking channel you run, if applicable]. The dynamic pricing system adjusts your rate daily based on demand, local events and what competitors are doing — so you’re never leaving money on the table in peak periods and you stay competitive in the slower ones.",
    keywords: [
      "platforms", "where do you list", "airbnb", "booking.com", "booking com",
      "channels", "which sites", "listing sites", "what sites", "vrbo",
      "where will it be listed",
    ],
  },
  {
    id: 10,
    tier: 2,
    category: "Revenue",
    profiles: ["Buy-to-STL", "STL Switch", "Ex-STL"],
    question: "Do you have real results I can look at?",
    headline: "[Insert your own recent, verifiable results here.]",
    answer:
      "Yes — [insert real performance data from your own portfolio here: property, location, gross/net income and occupancy for a recent full year]. (Past performance of other properties doesn’t guarantee future results for yours.)",
    keywords: [
      "case studies", "real results", "examples", "proof", "evidence",
      "other properties", "track record", "do you have examples", "results",
      "can you show me", "real numbers", "have you done this before",
      "comparable property", "comparable results",
    ],
  },
  {
    id: 11,
    tier: 3,
    category: "Situations",
    profiles: ["STL Switch", "Ex-STL"],
    question: "I’m comparing you with another company (Pass the Keys / Hostmaker).",
    headline: "Compare fees, contractor network and response time.",
    answer:
      "Completely fair — you should compare. The main things worth checking: [your management fee] vs what they charge; how they handle maintenance — [describe your maintenance or contractor set-up]; and how owner communication works — [describe your communication channel and response-time commitment]. Ask whoever you’re comparing with what their communication channel is and what response time they commit to.",
    keywords: [
      "other companies", "competitors", "pass the keys", "hostmaker",
      "comparing", "someone else", "other agency", "alternatives",
      "another company", "shopping around", "why you over",
    ],
  },
  {
    id: 12,
    tier: 2,
    category: "Legal & Tax",
    profiles: ["Buy-to-STL"],
    question: "Do I need a special mortgage or insurance?",
    headline: "Holiday-let mortgage or consent, plus short-let insurance.",
    answer:
      "You’ll need either a holiday let mortgage (if it’s a dedicated investment property) or your lender’s consent to let on a short-term basis — many lenders are fine with it. You’ll also need short-let / holiday let landlord insurance; some standard policies cover it, some don’t, so it’s worth checking with your provider. We can point you in the right direction, but we’re not financial advisers so we wouldn’t advise on the specifics.",
    keywords: [
      "mortgage", "insurance", "special mortgage", "consent to let",
      "holiday let mortgage", "landlord insurance", "permission from my lender",
      "do i need a different mortgage", "lender", "what insurance do i need",
    ],
  },
  {
    id: 13,
    tier: 2,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "How will I know what’s happening with my property?",
    headline: "Dedicated channel, live calendar, monthly statements.",
    answer:
      "You get a dedicated [your communication channel, e.g. Slack, WhatsApp or email] channel — that’s the main line of communication, and if something happens you hear about it there. We aim to respond within [your response-time commitment, e.g. 24 hours] during working hours. You also get a booking calendar where you can see all reservations in real time, and monthly income statements that go out [your statement window, e.g. between the 1st and 5th] of every month for the previous month’s bookings.",
    keywords: [
      "communication", "how do i know whats happening", "updates", "slack",
      "contact", "keep in touch", "reporting", "kept informed",
      "how do you communicate", "how will you keep me updated",
    ],
  },
  {
    id: 14,
    tier: 1,
    category: "Setup",
    profiles: ALL_PROFILES,
    question: "How long does it take to go live?",
    headline: "Live and taking bookings within a few weeks.",
    answer:
      "Once the agreement is signed, onboarding typically takes [your onboarding timeframe, e.g. two to four weeks] — sometimes quicker if the property is ready to go. We handle the listing setup, get you across all the booking platforms, arrange the photography and do the final checks. You’d be live and taking bookings within a few weeks.",
    keywords: [
      "how long", "how soon", "timeline", "when can i start", "go live",
      "how quickly", "how fast can we start", "when would it be live",
      "how long to set up", "time to go live",
    ],
  },
  {
    id: 15,
    tier: 3,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "How does the dynamic pricing work?",
    headline: "Rate auto-adjusts daily on demand, events and competitors.",
    answer:
      "The system adjusts your nightly rate every day based on demand, local events and what competitors are doing. That means you’re never leaving money on the table during peak periods, and you stay competitive — and booked — in the quieter ones. It’s constantly working to maximise your annual total rather than chasing a flat fixed rate.",
    keywords: [
      "pricing", "how do you price", "dynamic pricing", "set the rate",
      "nightly rate", "who decides the price", "how is the price set",
      "who sets the rates", "pricing strategy",
    ],
  },
  {
    id: 16,
    tier: 3,
    category: "Revenue",
    profiles: ["Buy-to-STL", "STL Switch"],
    question: "What occupancy are you projecting?",
    headline: "A conservative share of projected occupancy in Year 1.",
    answer:
      "The projection is based on real occupancy data for your area. In Year 1 we typically model around [your Year 1 modelling %, e.g. 80%] of the projected occupancy figure to stay conservative while the listing ramps up and builds reviews; from Year 2 it settles to the full projected rate. Our managed properties also run at strong average ratings ([your average rating, e.g. 4.7–4.8]), which lifts visibility and booking rate in the algorithm.",
    keywords: [
      "occupancy", "how often booked", "how full", "booked nights",
      "vacancy", "how many nights", "occupancy rate", "how booked up",
    ],
  },
  {
    id: 17,
    tier: 1,
    category: "Revenue",
    profiles: ALL_PROFILES,
    question: "How consistent is the income — what about quiet months?",
    headline: "Even the quietest month earns — anchor on the annual average.",
    answer:
      "The income is less even than a long let month to month, but it’s consistent across the year. The best months are your peak season; the slowest are usually January and February. Even in those months you’re still earning a solid net figure — the worst month is typically comparable to what a long let pays, and your best months far exceed it. The number to anchor on is the annual average, which smooths the seasonality out.",
    keywords: [
      "income consistency", "how consistent is the income", "consistent income",
      "consistency", "monthly", "seasonality", "busy months", "quiet months",
      "peak", "low season", "off season", "month by month", "breakdown",
      "which months", "seasonal", "busy season", "january and february",
      "dropping off in winter", "income dropping off",
    ],
  },
  {
    id: 18,
    tier: 3,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "What happens if there’s damage?",
    headline: "Photographed each stay — recovered via guest protection or deposit.",
    answer:
      "We photograph the property before and after every stay. If there’s damage we pursue recovery through the platform’s guest protection programme (e.g. Airbnb’s AirCover) or the guest’s security deposit (typically [your deposit amount, e.g. £200]), and we handle all of that for you. We can authorise repairs up to [your maintenance authorisation threshold] without needing to call you; anything above that, we come to you first. If we genuinely can’t recover something, we’ll be honest with you about it.",
    keywords: [
      "damage", "whats damaged", "broken by guest", "deposit", "aircover",
      "air cover", "who pays for damage", "if a guest breaks something",
      "damages", "something gets damaged", "damaged or stolen",
    ],
  },
  {
    id: 19,
    tier: 3,
    category: "Situations",
    profiles: ALL_PROFILES,
    question: "I’m worried about wear and tear.",
    headline: "Short stays are gentler — inspected and photographed.",
    answer:
      "It’s a real consideration. Short-term guests actually tend to be gentler on a property than long-term tenants — they’re staying two to five nights, not two years. We inspect the property regularly, photograph before and after every stay, and pursue any damage through the platform’s guest protection cover. Major wear items like mattresses and sofas have a lifespan regardless, and we’ll flag when something needs refreshing.",
    keywords: [
      "wear and tear", "wear", "damage over time", "condition",
      "run down", "gets worn", "worn out", "deterioration",
      "wear on the property",
    ],
  },
  {
    id: 20,
    tier: 3,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "Who actually books and stays in these properties?",
    headline: "Corporate, healthcare, leisure — a meaningful share returning.",
    answer:
      "It depends on your location, but typically a mix of corporate contractors, healthcare workers, city-break and leisure tourism, university and relocation stays. Properties near hospital clusters, for example, often do well with medical-visitor bookings. We only highlight demand drivers that genuinely apply to your area, and around [your returning-guest %, e.g. 30–40%] of bookings tend to come from returning guests — which significantly reduces the randomness of who’s in your property.",
    keywords: [
      "who stays", "who books", "what kind of guests", "who are the guests",
      "type of guest", "demand", "who rents it", "what guests",
      "who would stay there", "who actually books", "healthcare workers",
      "nhs workers", "healthcare and nhs", "nhs",
    ],
  },
  {
    id: 21,
    tier: 3,
    category: "Revenue",
    profiles: ["Buy-to-STL", "STL Switch", "Ex-STL"],
    question: "Do your projections actually match reality?",
    headline: "[Insert your own actual-vs-projected example here.]",
    answer:
      "They generally track closely. [Insert a real example here: an actual property’s real results measured against its original projection.] The figures come from live market data in your postcode — current listings, occupancy and nightly rates — and Year 1 is already discounted by around [your Year 1 discount %] for ramp-up. We’d always rather show you the real picture than an inflated number.",
    keywords: [
      "do projections match", "accurate", "hit your numbers",
      "reliable projections", "actuals", "do you hit the projections",
      "how accurate", "do you actually achieve",
    ],
  },
  {
    id: 22,
    tier: 2,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "What insurance and guest protection is in place?",
    headline: "Deposit, ID checks, guest-protection cover.",
    answer:
      "On every booking we collect a security deposit (typically [your deposit amount, e.g. £200]) and run ID checks. You’re also covered by [your own insurance level, if applicable] on top of the platform’s own guest protection programme (e.g. Airbnb’s AirCover, which covers property damage up to a set limit). In practice the vast majority of stays are completely incident-free — but if something does happen, we manage the claim and you never deal with the platform directly.",
    keywords: [
      "insurance", "protection", "covered", "aircover", "air cover",
      "deposit", "security", "what protection", "what cover", "am i covered",
      "what if something goes wrong",
    ],
  },
  {
    id: 23,
    tier: 3,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "Do you inspect the property?",
    headline: "Inspections a few times a year, plus per-stay photos.",
    answer:
      "Yes — we carry out property inspections, typically [your inspection frequency, e.g. one to three times per year], to make sure standards are being maintained. Combined with the before-and-after photos on every stay, it means the condition of your property is actively monitored rather than left to chance.",
    keywords: [
      "inspections", "do you check the property", "visit the property",
      "how often do you inspect", "inspect", "check on the property",
      "property checks",
    ],
  },
  {
    id: 24,
    tier: 2,
    category: "Setup",
    profiles: ALL_PROFILES,
    question: "What’s the onboarding process, step by step?",
    headline: "Sign → onboarding call → photos → listing → live.",
    answer:
      "Day 1 the agreement is signed. In the first few days we have an onboarding call and record the property details. If furnishing is needed, allow [your furnishing lead time, e.g. 2–4 weeks]. Any smart access equipment goes in during setup, then professional photography, the listing is created and optimised over a few days, and finally you go live on all platforms with bookings open.",
    keywords: [
      "onboarding", "process", "steps", "what happens after i sign",
      "setup process", "how does setup work", "what are the steps",
      "whats the process", "getting started", "what happens next",
    ],
  },
  {
    id: 25,
    tier: 2,
    category: "Setup",
    profiles: ["Buy-to-STL", "Abroad"],
    question: "What if the property isn’t furnished yet?",
    headline: "We can furnish it — itemised quote, recovered fast.",
    answer:
      "If the property needs furnishing, that’s something we can coordinate for you — or you can do it independently. We’ll send a setup quote with a clear itemised cost. Payment is typically upfront, and it’s usually recovered within the first few months of bookings.",
    keywords: [
      "furnishing", "furniture", "unfurnished", "do i need to furnish",
      "empty property", "furnish it", "its not furnished", "no furniture",
      "fit out",
    ],
  },
  {
    id: 26,
    tier: 3,
    category: "Setup",
    profiles: ["Buy-to-STL", "STL Switch", "Abroad"],
    question: "What setup do I need to provide?",
    headline: "A short list — typically a smart thermostat and key safe.",
    answer:
      "Very little. We’d recommend a smart thermostat so we can manage energy remotely — [your cost estimate, e.g. around £200] once — and a key safe for access, [your cost estimate, e.g. around £60]. That’s the extent of your one-off setup. Everything else is handled as part of onboarding.",
    keywords: [
      "what do i need", "what do i provide", "setup costs", "thermostat",
      "key safe", "what do i need to buy", "equipment",
      "what do i need to provide", "upfront costs",
    ],
  },
  {
    id: 27,
    tier: 3,
    category: "Service",
    profiles: ["STL Switch", "Ex-STL"],
    question: "Can I use my own cleaners?",
    headline: "Possible if they meet our standards — most use ours.",
    answer:
      "In principle yes — but they’d need to meet our standards and be available on a flexible schedule, including same-day turnaround between check-out and check-in. In practice most owners find it simpler to use our cleaning network. If you have a trusted local cleaner, let’s have that conversation — we can sometimes work with them.",
    keywords: [
      "my own cleaner", "use my cleaner", "existing cleaner",
      "can i clean it myself", "own cleaning", "my cleaner",
      "keep my cleaner",
    ],
  },
  {
    id: 28,
    tier: 2,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "What am I responsible for?",
    headline: "Only the bills — utilities, council tax, mortgage.",
    answer:
      "Just the bills — utilities, broadband, council tax and your mortgage. Everything operational sits with us: guest comms, bookings, check-ins and check-outs, cleaning, maintenance and pricing. The only one-off items on your side are typically [your setup items, e.g. a smart thermostat and key safe].",
    keywords: [
      "what am i responsible for", "my responsibility", "what do i pay for",
      "bills", "utilities", "council tax", "whats on me",
      "what do i have to cover", "what are my costs",
    ],
  },
  {
    id: 29,
    tier: 1,
    category: "Fees",
    profiles: ALL_PROFILES,
    question: "What’s your management fee?",
    headline: "[Your fee]% + VAT of gross — all-in, no hidden charges.",
    answer:
      "Our standard management fee is [your management fee]% plus VAT of gross revenue. That’s the full fee — everything is included: guest comms, pricing, cleaning coordination, maintenance and monthly reporting. There are no hidden charges on top. (For a full net breakdown of what you keep, see “what you actually keep”.)",
    keywords: [
      "fee", "cost", "how much do you charge", "whats your cut", "commission",
      "management fee", "what do you take", "your fee", "charges", "price",
      "how much do you take", "whats it going to cost", "what does it cost",
      "fee structure", "understand the costs", "understand the fees",
    ],
  },
  {
    id: 30,
    tier: 2,
    category: "Fees",
    profiles: ALL_PROFILES,
    question: "Is there a discount or special offer?",
    headline: "[Your promotional rate], if applicable — with a clear expiry.",
    answer:
      "Where we have a genuine deadline, we can sometimes offer a reduced rate — for example [your discounted rate]% plus VAT — if the agreement is signed by a stated date, after which it returns to the standard rate. There may also be a reduced rate for existing client referrals. Any offer should always have a clear expiry date stated upfront.",
    keywords: [
      "discount", "offer", "deal", "cheaper", "reduce the fee", "special rate",
      "lower fee", "negotiate", "any discount", "better rate",
      "can you do better",
    ],
  },
  {
    id: 31,
    tier: 1,
    category: "Revenue",
    profiles: ALL_PROFILES,
    question: "What happens if the property sits empty?",
    headline: "Slow months are factored in — annual average wins.",
    answer:
      "In the low months — typically January through March — there will be slower periods, and that’s already factored into the projection. The way to think about it: even your worst month is probably comparable to what a traditional let pays, and your best months far exceed it. The annual average is what matters.",
    keywords: [
      "empty", "void", "sits empty", "no bookings", "not booked", "vacant",
      "quiet periods", "what if it doesnt get booked", "unbooked",
      "what if nobody books", "income consistency", "dropping off in winter",
    ],
  },
  {
    id: 32,
    tier: 2,
    category: "Revenue",
    profiles: ["Buy-to-STL", "STL Switch"],
    question: "What does this look like after my mortgage?",
    headline: "A clear monthly profit after the mortgage is covered.",
    answer:
      "If we take your mortgage figure into account, even on the conservative Year 1 projection you’re typically looking at a clear monthly profit after the mortgage is covered — and that gap widens in Year 2 at the full run rate. It’s the cleanest way to see what actually lands in your pocket each month.",
    keywords: [
      "after mortgage", "mortgage payment", "cover the mortgage",
      "profit after mortgage", "net after mortgage", "pay my mortgage",
      "after my mortgage", "will it cover the mortgage",
    ],
  },
  {
    id: 33,
    tier: 3,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "What’s your response time and office hours?",
    headline: "[Channel], [response time] reply · [office hours].",
    answer:
      "Your main line is [your communication channel, e.g. a dedicated Slack channel], and we aim to respond within [your response-time commitment, e.g. 24 hours] during working hours. Office hours are typically [your office hours, e.g. Monday to Friday, 9:30am to 5:00pm]. Clear, responsive communication is consistently the part of the service owners rate most highly — you’ll always know what’s happening.",
    keywords: [
      "response time", "how fast", "office hours", "when are you open",
      "how quickly do you respond", "support hours", "how fast do you reply",
      "availability", "opening hours",
    ],
  },
  {
    id: 34,
    tier: 3,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "Can I see my bookings and income?",
    headline: "Live booking calendar + monthly income statements.",
    answer:
      "Yes — you get a booking calendar showing all reservations in real time, plus monthly income statements that go out [your statement window, e.g. between the 1st and 5th] of every month for the previous month’s completed bookings. Full visibility, without you having to chase anything.",
    keywords: [
      "see bookings", "calendar", "dashboard", "see income", "statements",
      "track income", "view bookings", "can i see whats booked",
      "do i get reports", "monthly statement",
    ],
  },
  {
    id: 35,
    tier: 2,
    category: "Fees",
    profiles: ALL_PROFILES,
    question: "Is there a software fee or any other costs?",
    headline: "[Your software fee]/month, if applicable — the only extra.",
    answer:
      "Some operators charge a small software or platform fee on top of the management fee — for example [your software fee, e.g. £42 per month], deducted from your payouts. If we charge one, it’s separate from the management fee and it’s the only additional fixed cost.",
    keywords: [
      "software fee", "extra fees", "other fees", "hidden fees", "monthly fee",
      "any other costs", "additional charges", "are there other costs",
      "anything else i pay", "hidden costs",
    ],
  },
  {
    id: 36,
    tier: 1,
    category: "Contract",
    profiles: ALL_PROFILES,
    question: "What’s the contract term?",
    headline: "[Initial term] fixed, then [notice period] rolling notice.",
    answer:
      "It’s typically a fixed initial term — for example [your contract term, e.g. six months] — to start, which gives us time to properly ramp up, build the reviews, optimise pricing and let the listing find its audience. After the initial term it usually moves to a rolling notice period — for example [your notice period, e.g. three months] — so either of us can step away with notice at any point.",
    keywords: [
      "contract", "term", "how long is the contract", "tie in", "tie-in",
      "commitment", "length of contract", "lock in", "locked in",
      "are we locked in", "how long am i signing up", "contract length",
      "notice period",
    ],
  },
  {
    id: 37,
    tier: 2,
    category: "Contract",
    profiles: ALL_PROFILES,
    question: "What if I want to exit early?",
    headline: "[Your early-exit fee], if applicable, within the initial term.",
    answer:
      "If you needed to exit within the initial term, there may be an early exit fee — for example [your early exit fee, e.g. £1,000] — that covers the onboarding investment made. In practice, once properties are live and earning, owners rarely exit; they simply don’t have a reason to.",
    keywords: [
      "exit", "cancel", "get out", "leave early", "terminate",
      "break the contract", "early exit", "cancellation fee", "pull out",
      "what if i want to leave", "change my mind",
    ],
  },
  {
    id: 38,
    tier: 3,
    category: "Setup",
    profiles: ALL_PROFILES,
    question: "When and how do I get paid?",
    headline: "Paid within a set monthly window for the prior month’s stays.",
    answer:
      "Payouts typically go out [your payout window, e.g. between the 1st and 5th] of each month, covering the previous month’s completed stays. They land directly with you, with a monthly income statement showing exactly how the figure is made up.",
    keywords: [
      "when do i get paid", "payouts", "payment", "wheres the money",
      "get paid", "payment schedule", "how do i get paid", "when am i paid",
      "when does the money come",
    ],
  },
  {
    id: 39,
    tier: 2,
    category: "Contract",
    profiles: ALL_PROFILES,
    question: "Six months feels like a long commitment.",
    headline: "The initial term protects the ramp-up — it’s accountability.",
    answer:
      "That’s fair — you’re committing before you’ve seen results. But think of it as performance accountability, not lock-in: it typically takes three to four months to properly ramp a listing — build the reviews, optimise pricing, find the audience. In the first couple of months here’s exactly what we do; by month three you should be seeing real results. With a very short term, owners would exit before the listing found its feet. The properties that see the best results are the ones that let the process run.",
    keywords: [
      "six months is long", "long commitment", "why six months",
      "thats a long tie in", "too long", "shorter contract",
      "do i have to commit for six months", "six month", "locked in",
      "try it for less time", "commit for 6 months",
    ],
  },
  {
    id: 40,
    tier: 3,
    category: "Legal & Tax",
    profiles: ["Buy-to-STL"],
    question: "Council tax or business rates?",
    headline: "Meeting the letting-days threshold → business rates route.",
    answer:
      "If the property is available for short-term let for more than 140 days a year and actually let for 70+ days, it can qualify for business rates instead of council tax in England — which often works out cheaper, and you may qualify for small business rates relief, meaning you could pay nothing. It’s a common route for owners in this position. We can’t advise on it officially, but it’s well worth checking with an accountant.",
    keywords: [
      "council tax", "business rates", "rates", "tax", "small business relief",
      "rateable", "do i pay council tax", "what about tax",
      "business rate",
    ],
  },
  {
    id: 41,
    tier: 2,
    category: "Situations",
    profiles: ["Abroad", "STL Switch"],
    question: "Can I use the property myself?",
    headline: "Yes — block dates, we clear around them, pay only cleaning.",
    answer:
      "Absolutely — it stays your property. You block the dates on the calendar and we clear the surrounding bookings so it’s ready when you arrive; you just message us via [your communication channel] to request a clean before you come in. The only cost is typically the cleaning fee for that stay. The key thing is lead time: in peak season, block early because confirmed bookings can’t be cancelled. In the quieter months you can block at short notice with minimal revenue impact.",
    keywords: [
      "use it myself", "stay there", "personal use", "block dates",
      "use the property", "my own use", "holiday in it", "stay in it myself",
      "can i use it", "live in it sometimes", "can i stay in my own property",
      "stay in my own home", "holiday in my own",
    ],
  },
  {
    id: 42,
    tier: 4,
    category: "Situations",
    profiles: ["Buy-to-STL", "STL Switch"],
    question: "Short-let feels riskier than a long let.",
    headline: "Different risks, not more — upfront pay, vetting, protection.",
    answer:
      "That’s a fair point — the income is less predictable month to month. But the risks with a long let are different, not absent: rent arrears, tenants who don’t leave, damage that’s harder to recover. With short-let platforms, every guest pays upfront, we vet every booking, and you’re backed by the platform’s guest protection cover. Different risks — not more risk.",
    keywords: [
      "risky", "risk", "riskier", "safer", "is it safe", "what are the risks",
      "more risky than renting", "sounds risky", "feels risky",
      "too risky",
    ],
  },

  // ── Situational / high-frequency objections ──
  {
    id: 43,
    tier: 1,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "How do I manage it if I live far away or abroad?",
    headline: "You don’t — we do. Full remote visibility from your phone.",
    answer:
      "You don’t manage it at all — we do, on the ground, wherever you are in the world. You get complete remote visibility: a dedicated [your communication channel] for anything that comes up, a live booking calendar, and monthly income statements. We handle check-ins, check-outs, cleaning, maintenance and every guest interaction locally, so distance makes no difference to how the property runs. Plenty of owners are overseas or hours away and run everything from their phone.",
    keywords: [
      "managing the property remotely", "manage it remotely", "manage remotely",
      "i live far away", "i live abroad", "im abroad", "overseas",
      "out of the country", "how do i oversee it", "remote management",
      "far from the property", "keep an eye on it from a distance",
      "i wont be in the country", "not nearby", "different city",
      "how do i keep on top of it",
    ],
  },
  {
    id: 44,
    tier: 1,
    category: "Fees",
    profiles: ALL_PROFILES,
    question: "What do I actually keep after all the fees?",
    headline: "Net = gross minus platform fee, our fee, cleaning, [software fee].",
    answer:
      "Here’s the full picture, not just a percentage. From the gross a guest pays: the booking platform typically keeps around 3% as its own fee, we take our [your management fee]% plus VAT, and cleaning comes out — but cleaning is usually charged to the guest, so it’s largely self-funding. There may also be a small software fee (for example [your software fee]/month). What’s left is your net — the figure on your monthly statement. The clearest way to see it is your net income laid out month by month for the first six months, which we can send as a worked example so there are no surprises.",
    keywords: [
      "how much do i actually keep", "what do i keep", "what do i actually keep",
      "fee structure", "understand the costs", "understand the fees",
      "total costs", "all the costs", "what are the total costs",
      "how much of the income do i keep", "net after fees", "take home",
      "breakdown of costs", "what comes out", "how much do i walk away with",
    ],
  },
  {
    id: 45,
    tier: 3,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "What’s the access notice period — can I get into my own property?",
    headline: "[Notice period] via [channel] to visit — protects confirmed bookings.",
    answer:
      "You can visit any time — we just ask for [your access notice period, e.g. 72 hours’] notice via [your communication channel] so we can work around any confirmed guest bookings and make sure there’s no clash. It isn’t about restricting you; it’s what lets us protect confirmed stays and keep your reviews and income intact. For a proper personal stay, you block the dates on the calendar and we clear around them.",
    keywords: [
      "72 hour", "72-hour", "seventy two hours", "access notice",
      "get into my own property", "visit my property", "access to my property",
      "can i go to the property", "owner access", "notice to visit",
      "how much notice to visit",
    ],
  },
  {
    id: 46,
    tier: 3,
    category: "Service",
    profiles: ["Buy-to-STL", "STL Switch", "Ex-STL"],
    question: "What do you do to boost my listing’s ranking / the algorithm?",
    headline: "Fast replies, complete listing, review velocity, top-host status.",
    answer:
      "Concrete things that move the platform’s algorithm: fast guest response times (we aim well inside the thresholds that protect top-host status), a fully complete, optimised listing, professional photography, and review velocity — getting your first reviews in quickly to build ranking signal. Add dynamic pricing that keeps you competitive every day, plus top-host status once earned (e.g. Airbnb Superhost), and your listing gets materially more visibility and bookings than a self-managed one.",
    keywords: [
      "algorithm", "algorithm boost", "boost my ranking", "listing ranking",
      "search ranking", "optimise the listing", "optimize listing", "seo",
      "visibility", "superhost", "get to the top of search", "how do you rank",
      "ranking", "how do you get more bookings",
    ],
  },
  {
    id: 47,
    tier: 3,
    category: "Service",
    profiles: ["Buy-to-STL", "STL Switch", "Ex-STL"],
    question: "Can I control the pricing or set a minimum nightly rate?",
    headline: "Dynamic pricing is ours, but we’ll set a floor with you.",
    answer:
      "Day-to-day pricing is handled by our dynamic system — it adjusts daily on demand, events and competitors, which is what maximises your annual total. But it’s collaborative: if you want a minimum nightly floor, or you disagree with a particular rate, we’ll set that with you. You’re never locked out of the conversation — most owners find that once they see the system out-earn a flat rate, they’re happy to let it run.",
    keywords: [
      "control the pricing", "pricing control", "set my own price",
      "minimum nightly rate", "set a minimum", "set the rate myself",
      "disagree with the price", "i want control over pricing",
      "can i set the price", "more control over pricing",
    ],
  },
  {
    id: 48,
    tier: 2,
    category: "Revenue",
    profiles: ["Buy-to-STL", "STL Switch", "Abroad"],
    question: "I’m nervous about the early weeks before it gets going.",
    headline: "First month: listing live, photos, first bookings & reviews.",
    answer:
      "That’s a fair concern — it’s execution risk, not the long-term model. Here’s what the first month actually looks like: listing created and optimised, professional photography live, you go live across the platforms, dynamic pricing starts working, and we push hard to land your first bookings and first reviews to build ranking signal. The early weeks are deliberately the most active period for us — that’s exactly when our work makes the biggest difference, which is why Year 1 is modelled conservatively at around [your Year 1 modelling %].",
    keywords: [
      "nervous about the early weeks", "early weeks", "first few weeks",
      "before it gets going", "slow start", "first 30 days", "first month",
      "getting started slow", "launch period", "take a while to get going",
      "how long until bookings", "start slow",
    ],
  },
  {
    id: 49,
    tier: 3,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "What if a guest steals or damages something?",
    headline: "Covered — deposit, ID checks, guest protection, before/after photos.",
    answer:
      "Every guest is ID-verified and vetted, and we hold a security deposit per booking (typically [your deposit amount, e.g. £200]). We photograph the property before and after every stay, so if something is taken or damaged we have the evidence and pursue recovery through the deposit or the platform’s guest protection programme (e.g. Airbnb’s AirCover, which can cover a substantial level of property damage and liability). We manage the entire claim, so you never deal with the platform directly, and the vast majority of stays are completely incident-free.",
    keywords: [
      "stolen", "theft", "steal", "take my things", "guest steals",
      "something goes missing", "rob", "my belongings", "valuables",
      "damaged or stolen", "what if they steal",
    ],
  },
  {
    id: 50,
    tier: 1,
    category: "Service",
    profiles: ALL_PROFILES,
    question: "What makes you different from other operators?",
    headline: "[Insert your genuine differentiator — reviews, response, fees.]",
    answer:
      "Our edge is [insert your genuine differentiator here — for example, how quickly you build reviews, your response-time commitment, your fee structure, or your track record]. When people estimate returns they often miss how competitive a market really is on review count and rating — if you’re not actively collecting reviews, you never build enough of a track record to rank and compete. [Insert your own review-velocity or performance stat here, if you have one.] That builds your rating and ranking quicker, which means more visibility, more bookings, and a listing that becomes genuinely competitive sooner.",
    keywords: [
      "what makes you unique", "what makes you different",
      "why choose you", "what sets you apart", "your usp",
      "unique selling point", "how are you different", "whats your edge",
      "why you", "what makes you special", "how do you get reviews",
      "review velocity", "how do you get more reviews", "review rating",
      "getting reviews", "how competitive is the market", "establishment",
    ],
  },
];

// Smart words / concept synonyms.
// Maps an abstract or off-vocabulary term the operator might type to the FAQ
// id(s) that hold the CLOSEST helpful answer — even when there is no exact
// question for it (e.g. "compliance", "pets", "safety certificates"). These
// feed both the live matching and the typeahead suggestions, so a near-miss
// search still surfaces something useful instead of "no match".
export const SMART_WORDS: Record<string, number[]> = {
  // Legal / tax / regulatory
  compliance: [12, 40, 22, 36],
  regulations: [12, 40, 22],
  regulatory: [12, 40],
  legal: [12, 40, 36],
  law: [12, 40],
  rules: [12, 40, 36],
  tax: [40, 12],
  taxes: [40, 12],
  vat: [29, 35],
  hmrc: [40],
  accountant: [40],
  licence: [40, 12],
  license: [40, 12],
  licensing: [40, 12],
  planning: [40, 12],
  // Safety / certificates (nearest: onboarding checks + insurance + maintenance)
  safety: [24, 22, 6],
  certificate: [24, 12],
  certificates: [24, 12],
  certification: [24, 12],
  gas: [24, 6],
  electrical: [24, 6],
  epc: [24, 12],
  fire: [24, 22],
  legionella: [24, 6],
  // Money
  cost: [44, 29, 35],
  costs: [44, 29, 35],
  fees: [29, 35, 44, 30],
  commission: [29, 44],
  income: [1, 17, 31, 44],
  earnings: [1, 44],
  profit: [1, 32, 44],
  yield: [1, 8, 32],
  roi: [1, 8, 21],
  guarantee: [17, 31, 42],
  guaranteed: [17, 31],
  refund: [37, 30],
  deposit: [22, 18],
  payment: [38],
  // Property / setup
  furnishing: [25, 26],
  furniture: [25, 26],
  keys: [26, 45, 2],
  checkin: [2, 43, 45],
  utilities: [28],
  bills: [28],
  wifi: [28],
  broadband: [28],
  thermostat: [26],
  // Guests / protection
  pets: [20, 7],
  pet: [20, 7],
  noise: [7, 18, 19],
  neighbours: [7, 19],
  neighbors: [7, 19],
  cameras: [22, 7],
  sensors: [22, 7],
  security: [22, 18, 7],
  theft: [49, 22],
  damage: [18, 22, 6],
  tourists: [20],
  corporate: [20],
  // Service / performance
  superhost: [46, 16],
  reviews: [50, 46, 3, 16],
  ranking: [46, 50],
  algorithm: [46],
  unique: [50],
  different: [50, 11],
  difference: [50, 11],
  usp: [50],
  edge: [50],
  special: [50],
  competitive: [50, 4, 8],
  remote: [43, 13],
  abroad: [43, 41, 13],
  overseas: [43, 13],
  // Contract
  contract: [36, 37, 39],
  cancellation: [37],
  exit: [37, 39],
  notice: [36, 37, 45],
  portfolio: [30, 21],
  multiple: [30],
};

// Buying-intent classification of each question. What a lead is asking
// signals where they are:
//   buying     = forward / closing signal (logistics, deal maths, evidence,
//                algorithm, payouts, personal use, discount)
//   evaluating = understanding / comparing (neutral, info-gathering)
//   concern    = objection / risk / skepticism (friction)
export const INTENTS: Record<IntentKey, IntentMeta> = {
  buying: { label: "Buying signal", short: "Buying", color: "rgb(93,129,86)", weight: 2 },
  evaluating: { label: "Evaluating", short: "Evaluating", color: "#d99a2b", weight: 1 },
  concern: { label: "Concern", short: "Concern", color: "#c2685a", weight: 0 },
};

const INTENT_BY_ID: Record<number, IntentKey> = {
  // Tier 1
  1: "evaluating", 2: "evaluating", 5: "evaluating", 7: "concern",
  8: "evaluating", 14: "buying", 17: "concern", 29: "evaluating",
  31: "concern", 36: "evaluating", 43: "concern", 44: "evaluating",
  // Tier 2
  3: "evaluating", 4: "concern", 6: "evaluating", 9: "evaluating",
  10: "buying", 12: "buying", 13: "evaluating", 22: "evaluating",
  24: "buying", 25: "buying", 28: "evaluating", 30: "buying",
  32: "buying", 35: "evaluating", 37: "concern", 39: "concern",
  41: "buying", 48: "concern",
  // Tier 3
  11: "concern", 15: "evaluating", 16: "evaluating", 18: "concern",
  19: "concern", 20: "evaluating", 21: "evaluating", 23: "evaluating",
  26: "buying", 27: "evaluating", 33: "evaluating", 34: "evaluating",
  38: "buying", 40: "buying", 45: "concern", 46: "buying",
  47: "concern", 49: "concern",
  // Tier 4
  42: "concern",
  // Differentiator
  50: "buying",
};

// Attach intent to each FAQ.
export const FAQS: Faq[] = RAW_FAQS.map((faq) => ({
  ...faq,
  intent: INTENT_BY_ID[faq.id] || "evaluating",
}));
