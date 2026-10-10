# Eval report

Run 2026-10-10T11:17:52.271Z · policy `2026-10-09.1` · model `gemini-3.1-pro-preview`

**20/20** phone transcripts routed as expected. Grounding check removed 0 unsupported extracted facts.
Tokens (all extractions): 19546 in / 25728 out.

| Call | Expected | Got | Result | Flags |
|---|---|---|---|---|
| T01 | qualified | qualified | ✅ | referral |
| T02 | qualified | qualified | ✅ | pricing_asked, tight_timeline |
| T03 | declined | declined | ✅ |  |
| T04 | declined | declined | ✅ | site_visit_requested |
| T05 | qualified | qualified | ✅ | vip_referral, site_visit_requested |
| T06 | qualified | qualified | ✅ |  |
| T07 | nurture | nurture | ✅ |  |
| T08 | no_conversation | no_conversation | ✅ |  |
| T09 | escalate | escalate | ✅ |  |
| T10 | declined | declined | ✅ | pricing_asked, budget_volunteered |
| T11 | qualified | qualified | ✅ | rented |
| T12 | qualified | qualified | ✅ | site_visit_requested, large_project |
| T13 | qualified | qualified | ✅ | pricing_asked |
| T14 | qualified | qualified | ✅ | proxy_caller |
| T15 | qualified | qualified | ✅ |  |
| T16 | qualified | qualified | ✅ | repeat_caller |
| T17 | qualified | qualified | ✅ | dropped_call |
| T18 | declined | declined | ✅ | pricing_asked |
| T19 | declined | declined | ✅ |  |
| T20 | qualified | qualified | ✅ |  |
