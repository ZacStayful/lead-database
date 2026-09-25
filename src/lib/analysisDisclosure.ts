/**
 * What a customer is told, where they buy the £3 analysis, about what happens
 * to the property's figures afterwards (§71).
 *
 * A paid analysis runs on the Stayful estimate software, which keeps each run
 * in the table STR-Website-2's Market Explorer is built from. So an analysed
 * property's postcode, bedroom count and figures become part of Stayful's
 * market data. The landlord's name, email and phone never leave this app
 * (analyserClient.ts sends the property only), and the estimate software
 * stores these runs without the street address.
 *
 * ⚠️ IMPORT-FREE, and it must stay that way. AnalysisOfferPanel and
 * ManualLeadForm are "use client" components (§21.8's rule).
 *
 * ⚠️ One definition, every surface that sells the analysis. Two wordings of a
 * data-use statement will eventually disagree, and the one a customer reads
 * is then the one that is wrong.
 */
export const ANALYSIS_MARKET_DATA_NOTE =
  "We only use the address to work out the figures. The postcode, number of bedrooms and the figures also go into Stayful’s market data, without the landlord’s name, contact details or street address.";
