// Curated vertical persona packs (T3.9). A pack is a one-click workspace:
//
//   persona  — a tuned agent persona installed through the existing persona
//              import path (PersonaIoService.sanitizePersona keeps only the
//              VALID_KEYS below, so every persona here stays within them).
//   panes    — starter sites opened as ordinary user tabs (ad-hoc spaces).
//   task     — one reusable agent task for the vertical, launched on demand.
//
// Skills are intentionally delivered as the persona overlay + followUps + the
// pack task rather than a .skill.json: there is no renderer surface for
// SkillsService, so a saved skill would be invisible/uninvocable. This module
// is pure data (no Electron, no IO) so it is trivially shared + unit-tested.

/** @typedef {{ label: string, url: string }} PackPane */

const PACKS = [
  {
    id: 'job-hunt',
    label: 'Job Hunt',
    description: 'Find roles, tailor applications, research companies, and prep for interviews.',
    persona: {
      name: 'pack_job_hunt',
      label: 'Job Hunt',
      description: 'Job-search assistant: roles, resumes, company research, interview prep.',
      systemOverlay:
        'You are a job-search assistant. Help find roles, tailor resumes and cover letters '
        + 'to a specific job description, research companies and interviewers, and track '
        + 'applications. Be concrete: extract the requirements from a posting, match them to '
        + "the user's background, and name the gaps. When given a job URL, summarize the role, "
        + 'must-have vs nice-to-have skills, red flags, and likely interview topics.',
      qualityOverride: null,
      starterTabs: [],
      notes: '',
      followUps: [
        'Summarize this job posting and split the skills into must-have vs nice-to-have',
        'Draft a cover letter tailored to this role and my background',
        "Research this company's recent news, products, and culture",
        'What interview questions are likely for this role, and how should I answer them?',
      ],
    },
    panes: [
      { label: 'LinkedIn Jobs', url: 'https://www.linkedin.com/jobs/' },
      { label: 'Indeed', url: 'https://www.indeed.com/' },
      { label: 'Glassdoor', url: 'https://www.glassdoor.com/Job/index.htm' },
      { label: 'HN Who Is Hiring', url: 'https://news.ycombinator.com/jobs' },
      { label: 'Levels.fyi', url: 'https://www.levels.fyi/' },
    ],
    task:
      'Search for roles matching my background posted in the last week, open the most '
      + 'relevant postings in separate panes, and for each give a one-line fit assessment '
      + 'plus the top three required skills. Ask me for the target role/location first.',
  },
  {
    id: 'travel',
    label: 'Travel',
    description: 'Compare flights and stays, build itineraries, check entry rules and budget.',
    persona: {
      name: 'pack_travel',
      label: 'Travel',
      description: 'Travel-planning assistant: flights, stays, itineraries, entry rules, budget.',
      systemOverlay:
        'You are a travel-planning assistant. Help compare flights and stays, build '
        + 'day-by-day itineraries, check visa/entry requirements and weather, and estimate '
        + 'budgets. Always state dates, total cost, and cancellation flexibility. Use '
        + 'official sources for entry requirements and flag anything time-sensitive.',
      qualityOverride: null,
      starterTabs: [],
      notes: '',
      followUps: [
        'Build a day-by-day itinerary for this destination and trip length',
        'Compare these flight options on price and total travel time',
        'What are the visa and entry requirements for this country right now?',
        'Find well-reviewed stays near the center under my budget',
      ],
    },
    panes: [
      { label: 'Google Flights', url: 'https://www.google.com/travel/flights' },
      { label: 'Google Maps', url: 'https://www.google.com/maps' },
      { label: 'Booking.com', url: 'https://www.booking.com/' },
      { label: 'Skyscanner', url: 'https://www.skyscanner.net/' },
      { label: 'Wikivoyage', url: 'https://www.wikivoyage.org/' },
    ],
    task:
      'Plan a trip: open flight search, a map, and lodging options in panes, then draft a '
      + 'day-by-day itinerary with an estimated total budget. Ask me for the destination, '
      + 'dates, and budget first.',
  },
  {
    id: 'deal-finder',
    label: 'Deal Finder',
    description: 'Compare prices, check price history, find legit coupons, avoid bogus discounts.',
    persona: {
      name: 'pack_deal_finder',
      label: 'Deal Finder',
      description: 'Deal-hunting assistant: price comparison, price history, legit coupons.',
      systemOverlay:
        'You are a deal-hunting assistant. Compare prices across reputable retailers, check '
        + 'price history, and find legitimate coupon or cashback options. Always show the '
        + 'real current price, the historical low, and the source. Flag inflated-list-price '
        + 'and scam patterns, and never recommend untrustworthy sites.',
      qualityOverride: null,
      starterTabs: [],
      notes: '',
      followUps: [
        'Compare the price of this product across major retailers',
        "What's the price history — is now a good time to buy or should I wait?",
        'Find legitimate coupons or cashback for this purchase',
        'Are there better-value alternatives to this product?',
      ],
    },
    panes: [
      { label: 'Google Shopping', url: 'https://www.google.com/shopping' },
      { label: 'Amazon', url: 'https://www.amazon.com/' },
      { label: 'CamelCamelCamel', url: 'https://camelcamelcamel.com/' },
      { label: 'Slickdeals', url: 'https://slickdeals.net/' },
      { label: 'RetailMeNot', url: 'https://www.retailmenot.com/' },
    ],
    task:
      'Find the best current price for a product: open price-comparison and price-history '
      + 'panes, then report the lowest legitimate price, the historical low, and whether to '
      + 'buy now or wait. Ask me which product first.',
  },
  {
    id: 'lit-review',
    label: 'Lit Review',
    description: 'Find papers, summarize methods and findings, build an annotated bibliography.',
    persona: {
      name: 'pack_lit_review',
      label: 'Lit Review',
      description: 'Literature-review assistant: scholarly search, synthesis, bibliography.',
      systemOverlay:
        'You are a literature-review assistant for research. Find peer-reviewed and preprint '
        + 'sources, summarize methods and findings, compare across papers, and build an '
        + 'annotated bibliography. Always cite title, authors, year, venue, and link, and '
        + 'distinguish primary results from claims. Prefer open-access sources.',
      qualityOverride: null,
      starterTabs: [],
      notes: '',
      followUps: [
        'Find recent papers on this topic and summarize each in three sentences',
        'Compare the methods and findings of these papers',
        'Build an annotated bibliography from the open-access sources',
        'What are the open problems and most-cited works in this area?',
      ],
    },
    panes: [
      { label: 'Google Scholar', url: 'https://scholar.google.com/' },
      { label: 'arXiv', url: 'https://arxiv.org/' },
      { label: 'Semantic Scholar', url: 'https://www.semanticscholar.org/' },
      { label: 'PubMed', url: 'https://pubmed.ncbi.nlm.nih.gov/' },
      { label: 'Connected Papers', url: 'https://www.connectedpapers.com/' },
    ],
    task:
      'Do a literature review on a topic: open scholarly search panes, find the most '
      + 'relevant recent papers, and produce an annotated bibliography with a short '
      + 'synthesis of the state of the art. Ask me for the topic first.',
  },
];

function getPack(id) {
  if (!id) return null;
  return PACKS.find((p) => p.id === id) || null;
}

module.exports = { PACKS, getPack };
