// Turns a call transcript into structured facts. Gemini only extracts; it
// never decides whether the lead qualifies (that's lib/qualify.js). Anything
// the caller didn't say stays null / 'unknown'.

const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { callStructured } = require('./llm');

const nstr = () => z.string().nullable();
const nnum = () => z.number().nullable();

const ExtractionSchema = z.object({
  call_type: z.enum(['new_enquiry', 'existing_client_issue', 'non_sales', 'no_conversation'])
    .describe('existing_client_issue = someone whose project with the studio is already under way (complaint, status chase). A caller chasing their own earlier unanswered ENQUIRY is still new_enquiry.'),
  caller_name: nstr(),
  language: z.string().describe('Main language the caller used, e.g. English, Hindi, Marathi, Hinglish.'),
  summary: z.string().describe('Two plain sentences a designer can read in five seconds.'),
  referral: z.object({
    how_found: nstr().describe('Instagram, LinkedIn, Google, friend referral, builder, etc.'),
    referrer_name: nstr(),
    knows_founder: z.boolean().describe('True only if the caller says the referrer is a friend or contact of Nikhil (the founder).'),
  }),
  project: z.object({
    segment: z.enum(['residential', 'commercial', 'hospitality', 'retail', 'fitness', 'other', 'unknown'])
      .describe('commercial = office, clinic, studio, coworking. hospitality = restaurant, cafe, hotel. fitness = gym.'),
    property_type: nstr().describe('e.g. "2BHK flat", "villa", "office", "coworking pod", "restaurant".'),
    locality: nstr().describe('Neighbourhood exactly as said, e.g. "Kothrud, Dahanukar Colony".'),
    city: nstr(),
    carpet_area_sqft: nnum().describe('Only if the caller states an area. Do not estimate from BHK.'),
    scope_type: z.enum(['full_home', 'partial', 'single_room', 'office_fitout', 'unknown']),
    rooms: z.array(z.string()).describe('Rooms or areas in scope, e.g. ["kitchen", "living room", "master bedroom"].'),
    room_count: nnum().describe('Number of rooms in scope if countable, kitchen counts as a room.'),
    current_state: nstr(),
    occupancy: z.enum(['owner', 'tenant', 'unknown']),
    structural_changes: z.boolean().describe('True only if they ask to move/break walls or change structure.'),
  }),
  engagement: z.object({
    wants_design_and_execution: z.enum(['yes', 'no', 'unknown'])
      .describe('no = only wants ideas, advice, colours, a visit, or will do execution themselves.'),
    signal: nstr().describe('The phrase that shows it.'),
  }),
  timeline: z.object({
    needed_by_text: nstr().describe('What they said about when it must be finished.'),
    weeks_until_needed: nnum().describe('Weeks from the call date until it must be complete. null if no deadline was given. If they say "X weeks", use X.'),
    site_available_text: nstr().describe('Only what physically blocks or allows work: possession date, tenants moving out, builder handover.'),
    weeks_until_site_available: nnum().describe('Weeks from the call date until the site can PHYSICALLY be worked on (possession, handover, vacating). 0 if they already have the space and nothing blocks work. Not their preferred start date. null if unknown.'),
    preferred_start_text: nstr().describe('When the caller would LIKE to start, if they said, e.g. "a January start would be ideal".'),
    flexible: z.boolean().nullable().describe('True if they say there is no rush / flexible.'),
  }),
  budget: z.object({
    volunteered: z.boolean().describe('True only if the caller stated a budget figure without being asked.'),
    max_inr: nnum().describe('Upper end of the stated budget in rupees (1 lakh = 100000).'),
    text: nstr(),
  }),
  decision_maker: z.object({
    status: z.enum(['self', 'authorised', 'proxy_decider_will_attend', 'research_only', 'unknown'])
      .describe('self = owner/decider. authorised = calling for a spouse/partner/boss who has said go ahead. proxy_decider_will_attend = calling for owners who will attend and decide. research_only = gathering info for someone who has not authorised them.'),
    detail: nstr(),
  }),
  pricing: z.object({
    asked: z.boolean(),
    times_pushed: z.number().int().describe('How many times they asked for a price, range or rate.'),
  }),
  complaint: z.object({
    is_existing_client: z.boolean(),
    detail: nstr(),
    designer_named: nstr(),
    requested_senior: z.boolean(),
  }),
  repeat: z.object({
    claims_prior_contact: z.boolean().describe('Caller says they contacted the studio before about this and were not followed up.'),
    detail: nstr(),
  }),
  dropped_call: z.boolean().describe('The transcript shows a call that disconnected and the caller rang back.'),
  requests: z.object({
    site_visit: z.boolean(),
    consultation_wanted: z.boolean(),
    preferred_slots: nstr(),
    email: nstr().describe('Email the caller gave, written normally (spoken "dot" and "at" converted to . and @). null if none.'),
  }),
  evidence: z.array(z.object({
    criterion: z.enum(['c1', 'c2', 'c3', 'c4', 'c5']),
    quote: z.string().describe('Short verbatim caller quote.'),
  })).describe('c1 project & execution, c2 location, c3 timeline, c4 budget, c5 decision-maker.'),
  open_questions: z.array(z.string()).describe('Facts a designer still needs that were not captured. Do not include price.'),
});

const KB_DIR = path.join(__dirname, '..', 'kb');
const services = () => fs.readFileSync(path.join(KB_DIR, 'services.md'), 'utf-8');

const SYSTEM = `You extract facts from phone calls to Aangan Studio, an interior design studio in Pune run by Nikhil Deshpande.
You only report what the caller said. You never decide if the lead is qualified, never estimate prices, and never fill a field the call doesn't support: use null, "unknown" or false.
Lines from "Front Desk" or "Agent" are the studio speaking; facts come from the caller. Transcripts may be in English, Hindi, Marathi or a mix.

For reference, what the studio does:
${services()}`;

async function extractCall({ transcript, callDate }) {
  const { data, usage } = await callStructured({
    system: SYSTEM,
    schema: ExtractionSchema,
    user: `Call date: ${callDate || 'unknown'}. Compute week counts relative to this date.

<transcript>
${transcript}
</transcript>`,
  });
  return { extraction: data, usage };
}

module.exports = { extractCall, ExtractionSchema };
