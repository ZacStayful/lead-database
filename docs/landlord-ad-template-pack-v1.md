<!--
  PROVENANCE — read this before the spec.

  This is the "Landlord ad template pack — spec v1" (2026-09-20) that migration
  0156 and CLAUDE.md §65 were built from. It was NEVER committed: it was pasted
  into the session that built the feature, and survived only as fragments quoted
  into CLAUDE.md and into code comments. It is not in Drive and not in Gmail.

  The cost of that was real. Six of the ten templates had no recorded name,
  angle or rule anywhere in the repository, and §65 ended up stating four things
  about this document that are wrong — see "Corrections" below. It is committed
  here verbatim so the next person works from the spec rather than from a
  paraphrase of it.

  ── Corrections to CLAUDE.md §65, all sourced from the text below ─────────────

  1. §65 says "defines ten templates". It is EIGHT CORE PLUS TWO OPTIONAL, and
     9 and 10 are switched off by default.

  2. §65 says "T3, T6, T7, T8 — the four whose claims gate is `none`". SIX of the
     eight are `none` (T3-T8); only T1 is `customer_data_required` and T2 is
     conditional. The four that shipped were selected by `photo: none`, not by
     claims gate. The same conflation is repeated at src/lib/ads/templates.ts:5
     and baked into templates.test.ts:47.

  3. §65 says the spec's five primary texts "became the five angles the model
     picks ONE of". The spec says `primary_text: 5 variants`, and each template
     lists exactly five named angles — ONE TEXT PER ANGLE, not a menu. The build
     asks the model for one text. This is the reason a run produces one generic
     ad.

  4. §65 bundles stage 4 as "photo layer, then T1/T2/T4/T5". T4 and T5 need only
     the photo layer (claims gate `none`); T1 and T2 need the CLAIMS GATE. Ship
     them separately — the half carrying legal exposure must not ride in on a
     layout change.

  Also specified here and missing from the build: `phone` and `property_types`
  are setup slots; the fee typo rule (under 8% or over 30%) is computed by
  feeVerdict() but never consulted on the write path; and the video needs no
  stock footage, because every scene draws on slots the static already uses.

  ── Open questions: one settled, one still open ───────────────────────────────

  The spec closes with three. Publishing was already settled in the text.

  * "Do customer ads have to carry a 'powered by' mark?" — SETTLED 2026-09-21:
    NO MARK on any creative. A local operator's only structural advantage is
    being local, and Template 4 is built entirely on that argument. The builder
    stays visibly a Stayful feature inside the app.

  * "Who owns a customer's ad if they leave: do the files stay downloadable?" —
    STILL OPEN.

  Nothing below this line has been edited.
-->

# Landlord ad template pack — spec v1

2026-09-20 · @Someone

Eight core templates plus two optional, for Lead Database customers to build their own landlord-facing Facebook and Instagram ads. Each renders as statics in every size and as a video from the same slots.

## How to read this

A template is one ad idea, defined once and rendered two ways: statics in every size, and a video built from the same slots. Customers choose a template and answer its inputs; they never edit a layout.

### Shared config shape

```yaml
id:           managed-from-city
name:         Managed from [city], not a call centre
audience:     any landlord in their area
theme:        light              # dark | light | paper
photo:        required           # required | optional | none
inputs:       [city, areas, years_trading, fee, review_score]
claims_gate:  none               # none | customer_data_required
copy:
  headline:     pattern with {slots}
  sub:          pattern with {slots}
  primary_text: 5 variants, written by Claude inside these bounds
  cta:          button text
static:
  layout:  [photo_hero, headline, proof_card, footer]
  sizes:   [4x5, 9x16, 1x1]
video:
  length:  24s
  audio:   captions | tts | customer_vo
  scenes:  hook / body / body / cta, drawing on the same slots
```

Scenes reference slots, not their own copy. A customer changing their fee updates the static and the video together.

### Slots collected once at setup

`company_name` · `logo` · `brand_colour` · `city` · `areas` · `fee` · `fee_vat` · `fee_public` · `years_trading` · `properties_managed` · `review_score` · `review_count` · `phone` · `landing_url` · `property_types`

Per-ad inputs are only what a template adds: a photo, a season, a customer-supplied figure.

### The claims gate

Landlord ads want to talk about income, which is an earnings claim and the likeliest cause of a rejected ad or a complaint. Because the system wrote it, the exposure is partly yours.

| Gate | Meaning |
| --- | --- |
| `none` | No income figures anywhere. Renders freely. Six of the eight core templates are built this way on purpose |
| `customer_data_required` | Has a money slot. Will not render until the customer enters their own figure, names its source and confirms it is their own data. The source is stored against the ad |

Two rules sit above every template: a customer's ad never implies a figure came from Stayful, and no template states or implies what a landlord will earn without the customer's own evidence behind it.

### The two objections every template works against

Stayful's own landlord leads raise two, and both are loss aversion rather than arithmetic. Income consistency is a certainty objection, answered with a worst case, not a best case. Setup cost is a timing objection, answered by shortening the time to break even. Templates that promise upside push against the grain; templates that remove uncertainty work with it.

## Addressing the reader

These ads interrupt people who were not looking for them, and most of the audience are not landlords. Every template must say who it is for and what it is about before it makes any argument, or it reads as a riddle and gets scrolled past. This is the rule the operator ads followed and the first draft of these templates did not.

Two required fields, on every template:

| Field | What it is | Where it must appear |
| --- | --- | --- |
| `addressed_to` | The line that names the reader — "Landlords", "If you own a property you let out", "Airbnb hosts" | First frame of the video, first line of the static, first sentence of the primary text |
| `category_line` | What the service is in plain words — "short let management", "Airbnb management" | Before any argument, in the first sentence |

Generation check: reject copy whose first sentence does not contain both the audience and the category. A landlord should know in one line that this is about their property and about a service; a non-landlord should know to keep scrolling.

### Location comes from targeting, never from an assumption

A template may only name a place when the customer has actually set one. Ask at ad setup, reusing what the Lead Database already knows:

- The customer **has a lead filter** — postcode areas or a radius already set: ask whether the ad should target the same areas. Default yes, since that is where they want work.
- The customer **has no filter**: ask which areas the ad should cover. Do not default to their business postcode, and do not skip the question.
- **They decline to narrow it**: the ad runs broad and every `{city}` slot falls back to the unlocated wording — "Landlords" rather than "Landlords in Leicester".

Where a place is used, the copy and the targeting must match. An ad that says Leicester while targeting the Midlands wastes the customer's money and reads as a mail-merge to everyone outside the city.

Every hook in the templates below is written in both forms: located, and unlocated.

## Template 1 — Your worst case, not your best case

Answers the certainty objection head-on: a long-let landlord knows exactly what arrives each month, and every short-let pitch they have seen leads with a best case they do not believe. This one leads with the worst case instead.

| Field | Value |
| --- | --- |
| Audience | Long-let landlord considering switching |
| Theme | dark |
| Photo | optional |
| Inputs | `city`, `property_type`, `worst_month`, `worst_month_source`, `long_let_rent` |
| Claims gate | `customer_data_required` |

### Copy

- **Addressed to** — Landlords letting long-term · **Category** — short let management
- **Headline, located** — "Landlords in {city}: our *quietest* short let month, not our best."
- **Headline, unlocated** — "Landlords: our *quietest* short let month, not our best."
- **Sub** — "{worst\_month} on a {property\_type}, against {long\_let\_rent} on a long let. Short let management from {company\_name}."
- **CTA** — Get a free estimate for your property
- **Primary text angles** — the certainty argument · what a quiet month looks like in practice · what a good month does, stated last and plainly · who this does not suit · plain facts, fee and what is included

### Static layout

Comparison card, two rows: the long let above in muted type, the quiet short-let month below in full contrast, with the customer's own source printed small beneath.

### Video, 24s

1. **Hook** — headline over the photo, or over the field if there is none. Full text at frame one.
2. **Body** — the long-let row draws in, then the quiet-month row lands beside it.
3. **Body** — one line on why the floor holds: occupancy, minimum stays, whatever the customer has entered.
4. **CTA** — end card: logo, fee line, "Get a free estimate".

### Claims note

This template cannot render on stock figures. The customer enters their own worst month, states where it came from (their own portfolio, a named property, a platform report) and confirms it is theirs. Store the answer with the ad. If they have no data, the UI should route them to template 7 instead.

## Template 2 — The empty months

Catches a landlord at the moment they are most persuadable: a tenant has given notice, or the property is sitting empty. A void costs a full month's rent and nobody plans for it.

| Field | Value |
| --- | --- |
| Audience | Landlord with a void now, or one recently |
| Theme | dark |
| Photo | optional |
| Inputs | `city`, `property_type`, `void_weeks` (optional, customer's own) |
| Claims gate | `customer_data_required` only if a money figure is used; the no-figure version renders freely |

### Copy

- **Addressed to** — A landlord with a tenant leaving, or a property sitting empty · **Category** — short let management
- **Headline, located** — "Landlord in {city} with a tenant leaving? An *empty* month costs a whole month."
- **Headline, unlocated** — "Tenant leaving? An *empty* month costs you a whole month."
- **Sub** — "We manage properties as short lets, so the gaps between bookings get filled instead of left."
- **CTA** — See what your property could do
- **Primary text angles** — the cost of a void, told plainly · the gap between tenancies · the landlord who is between tenants right now · a property that sits unlet over winter · plain facts, fee and what is included

### Static layout

Calendar-style card: twelve blocks across, one dim block marked "empty" against the rest filled. No figures unless the customer supplies them.

### Video, 24s

1. **Hook** — headline at frame one, calendar card beneath.
2. **Body** — one block dims and is labelled, the cost stated in weeks not pounds.
3. **Body** — the remaining blocks fill in sequence: "booked, booked, booked".
4. **CTA** — end card.

### Claims note

The default version uses no money at all: a void is described in weeks. If the customer wants to state what a void cost them, the gate applies and their figure is stored with its source.

## Template 3 — You'll never see the messages

Sells the absence of work rather than the presence of income, which is why it needs no figures and no photo. It is the template a customer with nothing but a logo can publish on day one.

| Field | Value |
| --- | --- |
| Audience | Time-poor landlord, or a self-managing host who is tired of it |
| Theme | paper |
| Photo | none |
| Inputs | `fee`, `fee_vat`, `fee_public`, `included` (multi-select of what they handle) |
| Claims gate | none |

### Copy

- **Addressed to** — Landlords, and hosts managing their own place · **Category** — short let management
- **Headline, located** — "Landlords in {city}: you'll never see the *3am* message."
- **Headline, unlocated** — "Landlords: you'll never see the *3am* message."
- **Sub** — "Full short let management. Guest messaging, cleaning, linen, pricing and check-ins, all handled by {company\_name}."
- **CTA** — Talk to us about your property
- **Primary text angles** — the message at 3am · the cleaner who cancels on a Friday · what a managed week looks like · the landlord who self-managed for six months · plain facts, fee and what is included

### Static layout

Two-column checklist: "We handle" ticked down the left, "You handle" with one line, usually "Nothing. We send you the statement."

### Video, 24s

1. **Hook** — headline at frame one on the ruled paper field.
2. **Body** — the "We handle" list ticks in, one item at a time, from the customer's own multi-select.
3. **Body** — the "You handle" column lands with its single line.
4. **CTA** — end card with the fee line if the customer publishes it.

### Claims note

None. Nothing here states an outcome. The only customer-specific numbers are their fee and their own service list, both of which they control.

## Template 4 — Managed from \[city\], not a call centre

The local operator's only structural advantage over a national brand, and the reason many landlords pick one manager over another. Needs a photo because a local claim with a stock image undoes itself.

| Field | Value |
| --- | --- |
| Audience | Any landlord in their patch |
| Theme | light |
| Photo | required — a property they manage, or their own town |
| Inputs | `city`, `areas`, `years_trading`, `properties_managed`, `review_score` |
| Claims gate | none |

### Copy

- **Addressed to** — Landlords in the areas they cover · **Category** — short let management
- **Headline, located** — "Landlords in {city}: short let management run from *{city}*, not a call centre."
- **Headline, unlocated** — "Landlords: short let management run by people *near* your property, not a call centre."
- **Sub** — "{years\_trading} years, {areas}. Your keys stay local."
- **CTA** — Talk to someone nearby
- **Primary text angles** — who turns up when something breaks · the national brand's call centre, as a category not a competitor · the areas covered, listed · how fast someone can reach the property · plain facts, fee and what is included

### Static layout

Photo across the top with a dark scrim, headline over it, proof card beneath: years, properties, review score. Areas listed as chips under the card.

### Video, 24s

1. **Hook** — photo with the headline over it, full text at frame one.
2. **Body** — the area chips land one at a time.
3. **Body** — proof card: years, properties managed, review score.
4. **CTA** — end card with the phone number if they have given one.

### Claims note

None, but the review score must be their real one and is displayed with its count, so nobody can publish "5.0" off two reviews without it being visible.

## Template 5 — Already on Airbnb, doing it yourself?

The easiest sale in the set, because the landlord has already decided short letting works. Nothing needs converting; the only question is who runs it. Photo required, since the ad should look like the listing they already have.

| Field | Value |
| --- | --- |
| Audience | Self-managing host, and the host whose co-host has just quit |
| Theme | light |
| Photo | required — a property interior |
| Inputs | `city`, `fee`, `fee_vat`, `fee_public`, `included`, `switch_time` (how long onboarding takes) |
| Claims gate | none |

### Copy

- **Addressed to** — Hosts running their own Airbnb listing · **Category** — short let management
- **Headline, located** — "{city} Airbnb hosts: keep the listing, lose the *admin*."
- **Headline, unlocated** — "Airbnb hosts: keep the listing, lose the *admin*."
- **Sub** — "{company\_name} takes over the calendar, the guests and the cleaning. Your listing keeps its reviews."
- **CTA** — See how a handover works
- **Primary text angles** — the handover, step by step · the reviews and ranking they keep · what happens to existing bookings · the co-host who stopped replying · plain facts, fee and what is included

### Static layout

Three-step handover card: "You hand over the login", "We take the calendar", "You get the statement". Photo above with a scrim.

### Video, 24s

1. **Hook** — photo and headline, full text at frame one.
2. **Body** — the three steps light in turn, the middle one marked as theirs to do nothing about.
3. **Body** — one line on reviews and existing bookings carrying over.
4. **CTA** — end card with the fee line and switch time.

### Claims note

None. Avoid any wording suggesting a ranking or revenue improvement after switching, even though that is the implied hope: it is an outcome claim and unprovable per property.

## Template 6 — The rules keep changing

For the cautious landlord, the one who would short-let but is not sure it is allowed. Strongest in licensing areas, where the rules are the reason they have not started.

| Field | Value |
| --- | --- |
| Audience | Cautious landlord; any landlord in a licensing or registration area |
| Theme | paper |
| Photo | none |
| Inputs | `city`, `councils` (areas they operate in), `handled` (multi-select: licensing, registration, fire safety, gas and electrical, insurance, guest ID) |
| Claims gate | none |

### Copy

- **Addressed to** — Landlords wondering whether short letting is even allowed · **Category** — short let management
- **Headline, located** — "Landlords in {city}: short let rules, *handled*."
- **Headline, unlocated** — "Landlords: short let rules, *handled*."
- **Sub** — "Licensing, safety certificates, insurance and guest records. We keep the file, you keep the property."
- **CTA** — Ask what applies to your property
- **Primary text angles** — what a landlord is actually responsible for · the certificate nobody remembers until renewal · what changed locally and what it means · the file we keep on every property · plain facts, fee and what is included

### Static layout

Document-style checklist on the paper theme, each item ticked, with the councils listed beneath as plain text.

### Video, 24s

1. **Hook** — headline at frame one on the ruled field.
2. **Body** — the checklist ticks down, item by item, from the customer's multi-select.
3. **Body** — a line naming the councils they cover.
4. **CTA** — end card.

### Claims note

None on income, but this template carries a different risk: it states what a customer handles. Only items they tick may appear, and the copy must never imply legal advice or that compliance is guaranteed. Suggested fixed line in the footer: "Responsibility stays with the property owner; we manage the process."

## Template 7 — What would your property earn?

The volume template, and the one to make the default. It offers a calculation rather than a claim, which is why it can talk about income without triggering the gate: the number belongs to the landlord's own property and is produced after they enquire.

| Field | Value |
| --- | --- |
| Audience | Everyone, top of funnel |
| Theme | light |
| Photo | optional |
| Inputs | `city`, `property_types`, `turnaround` (how quickly they reply) |
| Claims gate | none — the ad promises a figure, never states one |

### Copy

- **Addressed to** — Any landlord with a property let out, or empty · **Category** — short let management
- **Headline, located** — "Landlords in {city}: what would your property earn on *short lets*?"
- **Headline, unlocated** — "Landlords: what would your property earn on *short lets*?"
- **Sub** — "Send the postcode and bedroom count. We'll run the numbers against your current rent."
- **CTA** — Get my estimate
- **Primary text angles** — the question asked plainly · what the estimate is based on and what it is not · the landlord who assumed it was not worth it · how long an answer takes · what happens after, so nobody fears a sales call

### Static layout

Form-style card with the property fields filled and the estimate row left open, marked "Waiting on your postcode" in amber. It mirrors the product's own lead card, which is why it feels concrete.

### Video, 24s

1. **Hook** — the question at frame one, card beneath.
2. **Body** — the fields fill: postcode, bedrooms, current rent.
3. **Body** — the estimate row stays open and pulses, with a line on how the figure is produced.
4. **CTA** — end card, "Get my estimate".

### Claims note

The ad must never show an example estimate, not even a plausible one, because a specific figure in the creative is a claim regardless of the disclaimer beneath it. The open row shows what will be filled in, not what it will say. Pairs best with an instant lead form: postcode, bedrooms, current rent.

## Template 8 — Years, properties, review score

The trust template. A landlord hands over a property worth six figures, so the bar is higher than for most services. This one makes no argument at all: it states what the operator is and lets that do the work.

| Field | Value |
| --- | --- |
| Audience | The sceptical landlord, and anyone comparing two managers |
| Theme | dark |
| Photo | none |
| Inputs | `years_trading`, `properties_managed`, `review_score`, `review_count`, `city` |
| Claims gate | none |

### Copy

- **Addressed to** — Landlords comparing managers · **Category** — short let management
- **Headline, located** — "Short let management in {city}: {years\_trading} years, {properties\_managed} properties, *{review\_score}* on Google."
- **Headline, unlocated** — "Short let management: {years\_trading} years, {properties\_managed} properties, *{review\_score}* on Google."
- **Sub** — "Managing short lets across {areas} for landlords who would rather not."
- **CTA** — Talk to {company\_name}
- **Primary text angles** — how long they have been doing this · what {properties\_managed} properties means day to day · what landlords say, in their words if a quote is supplied · why they started · plain facts, fee and what is included

### Static layout

Three stat blocks across the card, review count small beneath the score. Nothing else.

### Video, 24s

1. **Hook** — the three numbers at frame one, no animation on the text.
2. **Body** — each stat gets one line of context, in turn.
3. **Body** — a review quote if supplied, in quotation marks with a first name.
4. **CTA** — end card.

### Claims note

Every figure is the customer's own and each must be entered, not inferred. The review score always renders with its count. A quote may only be used if the customer confirms it is real and published somewhere; store where it came from, exactly as with template 1's figures.

## Optional templates 9 and 10

Both are switched off by default. Nine only appears for customers who offer guaranteed rent; ten needs a date and goes stale, so it should expire on its own.

### Template 9 — Guaranteed rent instead

| Field | Value |
| --- | --- |
| Audience | The landlord who wants certainty above everything |
| Theme | dark |
| Photo | optional |
| Inputs | `term_years`, `city`, `property_types`, `rent_offer_basis` |
| Claims gate | `customer_data_required` if any rent figure appears |

- **Headline** — "The same rent, every month, for *{term\_years} years*."
- **Sub** — "No voids, no management fee, no guest to deal with. We take the property on and pay you monthly."
- **Static** — comparison card: guaranteed rent against managed letting, three rows, no figures unless supplied.
- **Video** — hook, then a calendar of twelve identical months, then the term, then the end card.

This is the certainty objection answered completely, so it converts the most hesitant landlords and the least profitable ones. Worth flagging in the UI that it competes with their own management offer.

### Template 10 — \[City\] is busy in \[season\]

| Field | Value |
| --- | --- |
| Audience | Landlords near an event or a seasonal peak |
| Theme | light |
| Photo | required — the city, the venue or the area |
| Inputs | `city`, `season_or_event`, `event_dates`, `lead_time` |
| Claims gate | none — demand may be described, never a price or an income |

- **Headline** — "{city} is full in {season\_or\_event}."
- **Sub** — "If your property is sitting empty, we can have it live before {event\_dates}."
- **Static** — photo hero, dates card, one line on how long onboarding takes.
- **Video** — hook over the photo, dates land, onboarding time, end card.

Add an expiry: the ad should stop rendering and warn the customer once `event_dates` has passed, or the library fills with last year's ads.

## Build notes

Ship statics for the four no-photo templates first. That is a usable feature, needs no queue, no photo pipeline and no audio, and it tells you whether customers make ads at all before the expensive parts get built.

### Order

| Stage | Scope | Why |
| --- | --- | --- |
| 1 | Statics, templates 3, 6, 7, 8 | No photo, no claims gate, renders inline in a second or two |
| 2 | Video for the same four, captions only | Needs the queue and worker; no voice cost, no music licence |
| 3 | AI voiceover on the templates that get used | One voice per template, generated per ad |
| 4 | Photo layer, then templates 1, 2, 4, 5 | Upload, crop per ratio, scrim, reject rules |
| 5 | Optional 9 and 10 | Per-customer switches |

### Setup questions, asked once

Company name, logo, brand colour, city and areas covered, fee and whether it is published, years trading, properties managed, review score and count, phone, landing URL, property types. Validate the fee: under 8% or over 30% is almost certainly a typo, and a wrong fee in a live ad is worse than no ad.

### Photo rules

Minimum 1200px on the short side, rejected with a reason if smaller. Auto-crop per ratio from the centre with drag to reposition, since 4:5 and 9:16 crops of the same photo are different pictures. Dark scrim behind any text over an image. Warn on recognisable faces, which are a consent problem for the customer. If a photo fails, fall back to the card-only variant rather than failing the render.

### Copy guardrails

Claude writes the five primary texts and the sub inside each template's bounds, never the headline pattern itself. Then check the output before it renders: reject any figure not in the customer's own inputs, any income or occupancy claim, any superlative that implies a market position ("the best in {city}"), and any mention of Stayful. A rejected generation retries once, then falls back to the template's default copy.

### Render outputs

Statics at 4:5, 9:16 and 1:1; video at 9:16, 24 seconds, with 4:5 worth adding later for feed. Expect roughly a minute per video render on a modest worker, so cap regenerations per plan and set a retention rule on stored files.

### Open questions

- Publishing: settled. The Lead Database connects to the customer's own Meta ad account, sets the ads up for them, and reports back on a live dashboard. See the section below.
- Do customer ads have to carry a "powered by" mark, and does that help or hurt their credibility as a local operator?
- Who owns a customer's ad if they leave: do the files stay downloadable?

## Ad account integration and the live dashboard

The customer connects their own Meta ad account, the Lead Database builds the campaign from the templates they chose, and a dashboard reports what each ad costs — with cost per lead shown against the £15 a Stayful lead costs.

### What it takes

| Piece | Detail |
| --- | --- |
| App review | `ads_management` and `leads_retrieval` permissions on a Meta app. Weeks, not days, and a working demo to submit |
| Business setup | The customer grants your Business Manager access to their ad account and Page; a system user token per customer, refreshed |
| Creation | Campaign, ad set and ads created from the template config, with the rendered files uploaded as the creative |
| Reporting | Insights pulled on a schedule and shown per ad: spend, impressions, link CTR, cost per link click, leads, cost per lead |
| Leads back | Instant Form leads retrieved and written into their CRM beside their Stayful leads |

### The comparison, and the risk in it

Showing their cost per lead against £15 is the most persuasive thing in the product when their ads cost more, and an argument to cancel when their ads cost less. Two things keep it honest and still in your favour.

- **Compare like with like.** Their Facebook lead is a form fill from a cold scroll. A Stayful lead is a landlord who searched, was financially modelled, and has been told an operator will call. Show cost per lead next to a downstream number — calls booked, or signed — never price alone.
- **Count the whole cost.** Their figure excludes creative, ad management time and the days a campaign spends in the learning phase. A dashboard that shows spend plus time is both fairer and better for you.

If a customer's ads genuinely beat £15 on quality-adjusted cost, the honest answer is that they should run both. That is also the answer that keeps them subscribed.

### Build order

1. Read-only first: connect the account, pull insights, show the dashboard for ads they already run. Fewer permissions, and it proves the comparison.
2. Then creation: publish templates into their account as paused ads they approve.
3. Then lead retrieval into the CRM.
4. Then automation: budget guidance and the kill rules applied to their live ads.
