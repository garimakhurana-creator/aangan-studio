# Aangan Studio — AI front desk

An AI phone front desk for **Aangan Studio**, a Pune interior design studio (MESA Case 03). Every call is answered day or night by a Vaani voice agent, qualified against the founder's own rubric, and handed to a designer with everything the caller already said, while the founder sees what it costs and what it generates.

**Live dashboard:** https://aangan-studio-tau.vercel.app (use **Replay calls** to run September's transcripts through the full pipeline).

## The problem

| Case number | |
|---|---|
| Enquiries per month | ~200 |
| No reply within 48 h | ~48% |
| Arrive outside 10am–7pm | ~33% |
| Reply within 1 h vs next day | 4× conversion |
| Average project | ₹8–14 lakh |

Designers also got leads as bare forwards and re-asked everything on the first call.

## What it does

1. **Answers every call** (Vaani agent "Shruti", Gemini at temperature 0.2, English / Hindi / Marathi). It discloses it is the studio's virtual assistant.
2. **Qualifies with Nikhil's five criteria** (`kb/qualified.md`): real project, Pune/PCMC, realistic timeline, budget broadly right, decision-maker. Gemini only *extracts facts*; a deterministic rules engine (`lib/qualify.js`) decides, with a reason code and evidence for every criterion.
3. **Never quotes a price.** Nikhil asked for live per-sq-ft quotes; his own `pricing.md` forbids any number. That is **the cut**: the agent uses his approved line and offers the free consultation. The dashboard tracks whether price-askers still book.
4. **Hands off by email** with a "don't re-ask" brief, five-criteria evidence, flags (VIP, repeat caller, proxy caller, rented, large project) and an **I've got this** link. Telegram posts a short heads-up for every new qualified enquiry (who, what, where, booked slot, dashboard link) plus Nikhil's urgent alerts (existing-client complaints, failures, handoffs not picked up).
5. **Pre-books via Calendly**: Shruti asks which day and time suit the caller ("Saturday morning", "Monday at 11"). After the call the server finds the earliest free Calendly slot that matches and books it; Calendly sends the invite and we email a confirmation with a reschedule link. If no slot matches or no time was given, a single-use booking link is emailed instead, and the designer brief says why. The agent never says "you're booked" during the call, because it can't see the calendar.
6. **Shows the founder everything**: a *Today* view (what needs you, split qualified / not qualified), a *Leads* board for designers (urgent / new / picked up, and not-qualified with reasons; search, area, type, quick filters, sort) and *Reports* (funnel, outcomes, price questions, cost per call / lead / booking, AI health).

## Guardrails against made-up answers

| Layer | Where |
|---|---|
| Closed list of sourced facts the agent may say | `kb/faq.md` |
| No calendar or records in the agent's hands; it promises a link, never a booking | `agent/prompt.template.md` |
| Read-back of name, email, locality before closing | prompt |
| Post-call fact-check of every agent line (prices, false bookings, invented people/offers/history, unapproved numbers) | `lib/factcheck.js` |
| Extraction grounding: any fact the caller never said is removed before it reaches a designer or the CRM | `lib/verify-extraction.js` |

## Policy conflicts surfaced, not guessed

`config/policy.json` versions every rule and marks the ones the source documents disagree on (`confirmed: false`): 6 vs 8–10-week timeline, the unwritten 500 sq ft office minimum, and "fail one" vs "fail two" in the rubric. A lead that would be declined only because of an unconfirmed value goes to **review**, never to a decline.

## Results

| Check | Result |
|---|---|
| Unit + pipeline tests (`npm test`) | 53 / 53 |
| September phone transcripts routed as expected (`npm run eval`) | 20 / 20 |
| Red-team: price extraction and hallucination baits (`npm run redteam`) | 24 / 24, 0 violations |

The transcript eval caught a real flaw (a caller's *preferred* January start read as "site not available"), and the red-team caught the agent inventing a designer-assignment policy and ending a call without the next step. Both are fixed and covered by tests.

## Architecture

```
Caller → Vaani agent (generated prompt + FAQ + guardrails)
       → call_postprocessing webhook → /api/vaani/webhook
       → Gemini extraction → grounding check → rules engine → fact-check
       → merge dropped call / mark repeat caller
       → HubSpot (contact, deal, note, task) · Calendly: book the slot they asked for (or a link) → email to caller
         · designer email with accept link · Telegram: new-lead heads-up + alerts to Nikhil
       → Neon Postgres (calls, leads, events) → dashboard
```

Every external action runs at most once per idempotency key; a failure is logged as `failed` with a Retry button, and the lead is never lost.

## Run it

```bash
npm install
cp .env.example .env      # add GEMINI_API_KEY at minimum
npm start                 # http://localhost:3000
npm test                  # rules, guardrails, pipeline with faked integrations
npm run eval              # 20 transcripts vs eval/golden.json (needs the course transcripts)
npm run redteam           # adversarial callers against the agent prompt
npm run vaani:sync        # create/update the Vaani agent from config/policy.json
```

Without integration keys every action is logged as *skipped*, so the whole flow can be demonstrated offline. The 20 anonymised September transcripts are in `eval/transcripts`, with their saved extractions in `eval/cache`, so replays work on any deploy without a Gemini key.

## Repository map

| Path | What |
|---|---|
| `config/policy.json` | Versioned rules, thresholds, approved lines |
| `kb/` | Studio services, pricing guide, rubric, approved facts |
| `agent/` | Prompt template and generator |
| `lib/qualify.js` | Rules engine |
| `lib/extract.js`, `lib/verify-extraction.js` | Gemini extraction and grounding |
| `lib/factcheck.js`, `lib/guardrail.js` | Checks on what the agent said |
| `lib/pipeline.js` | Post-call orchestration, idempotent actions, review, accept, SLA sweep |
| `lib/integrations/` | HubSpot, Calendly, Resend email, Telegram |
| `lib/metrics.js` | Every dashboard number, with its definition |
| `web/` | Dashboard |
| `eval/` | Golden labels, transcript replay, red-team |
| `test/` | Tests |

Photos in the dashboard are from Unsplash (Clay Banks, Lotus Design N Print, Brooke Balentine, Aalo Lens).
