# Aegis: Gap Analysis and Complete Workflow

## 1. What was wrong with the original UI

The screens looked right, but the browser was simulating everything.

| Original behavior | Why it conflicts with the plan | Now |
|---|---|---|
| Any upload closed the worker's first case and set "Verified 100%" | Plan: "document uploaded" is not "requirement satisfied" | Evaluator decides; only a Pass closes a case |
| AI confidence was always 99.8% | Ambiguous evidence must go to review | Real field matching with a review queue |
| Metrics used fake floors and fixed text ($2,520, +38%, 1.4 days) | Plan requires measured results | Calculated from records, or "Not measured" |
| Checks were 10 per worker, split by label | Every check needs a reason, evidence and version | Real evaluations stored per control |
| Audit hashes came from `Math.random()` and claimed SOC2/HIPAA | Not verifiable | SHA-256 hash chain, append-only, verify button; compliance claims removed |
| "Draft & Activate" went live at once | Plan requires preview and approval | Draft → preview → approval → active |
| Import had no file input and reset to a fixed list | Spreadsheet onboarding is core | Real Excel/CSV preview and commit |
| HRMS sync overwrote workers and deleted cases | Needs incremental sync | Upsert, cursor sync and signed webhooks |
| Reminders only wrote a log line | Must send once and follow up | Idempotent action service, reminders, escalation |
| Chat matched three phrases and echoed the rest | Chat and dashboards must share records | Same read models as the dashboard |
| "Verified 100%" per worker; "Compliance Guarantee" banner | Plan: cannot guarantee 100% | Scoped statement on every report |
| Data rendered with unescaped `innerHTML` | A worker name could run a script | Escaped templates and a strict CSP |
| All state in localStorage | No tenants, permissions or durability | SQLite, sessions, roles, tenant scoping |

## 2. What was missing and is now built

| Plan point | Added |
|---|---|
| 3. Onboarding | 5-step Company Setup, data gaps, facility requirements, channel, first assessment |
| 4. Connectors | HRMS client, signed webhook, incremental polling, common worker model, connector errors |
| 5. Packs | Four versioned JSON packs, requirement types, validation tests, reviewed activation, owners |
| 6. Controls | Pass/Fail/Unknown/N/A, overrides kept separate, custom controls, affected-record preview |
| 7. Evidence | Secure worker links, bulk upload, encrypted storage, field inspector, accept/reject, case lifecycle |
| 7. Approvals | Approvals inbox for messages, controls, assignment decisions, readiness and tax notices |
| 8. Reporting | Saved role-based dashboards, CSV reports, digests, critical alerts, chat commands |
| 9. Architecture | Durable jobs with retries, idempotent actions, tenant isolation, RBAC, restricted immigration access, injection handling |
| 10. Pilot | Validation mode with owner sign-off, false-finding tracking, pilot scorecard, external test tenant |
| Tax | Filing calendar evidence, entity and period matching, notice intake with drafted response |

## 3. The complete workflow

```
HRMS webhook / polling / spreadsheet / manual
        ↓  signed, de-duplicated event stored
Common worker record (worker, assignment, facility, entity)
        ↓  durable job
Control evaluator: active pack controls + approved overrides + accepted evidence
        ↓
Pass / Fail / Unknown / Not applicable, with reason, evidence IDs and control version
        ↓  gap found
One case per subject and control → assigned to the pack owner
        ↓
Validation mode: owner confirms or rejects the finding. Nothing is sent.
Automatic mode:  evidence request or restricted owner task, sent exactly once
        ↓
Worker uses secure link / owner uploads / bulk upload
        ↓
Extraction → match to worker and control → injection check
        ↓                                ↓
   Clear match: accepted           Uncertain: human review (accept or reject)
        ↓                                ↓ rejected: asked to resubmit
Evaluator reruns
        ↓
Pass → case closes with evidence.   Still failing → stays open
        ↓ no response
Reminders on schedule → escalation → assignment decision for a person
        ↓
Dashboards, chat, reports and digests read the same records
Every step is written to the hash-chained audit log
```

Rules enforced in code and covered by `test/workflow.test.js`:

- Sending a reminder or adding a note never closes a case.
- Missing, stale or unreviewed evidence never produces a Pass.
- A retried job or repeated webhook does not send twice.
- Aegis records assignment decisions but does not change the assignment.
- Immigration records are hidden from roles without access, and messages omit names.

## 4. What is needed before real use

These need your input or accounts. They were not available in this build.

| Item | Status | What is needed |
|---|---|---|
| Real HRMS API | Connector is ready and configurable. The mock in `server/mock-hrms.js` stands in until the key arrives | API URL, key and a sample response. Then follow `docs/HRMS-CONNECTOR.md` (no code change) |
| Pack content | Starter rules, marked for review | Compliance, immigration and finance owners must confirm each rule and source |
| Document reading | Text and text-based PDF work without AI | Paste a DeepSeek or Claude key in Settings > AI Engine for photos and chat. Neither has been run against the live service yet. DeepSeek cannot read scanned PDFs |
| Slack | Coded, not tested against a live workspace | Bot token and signing secret |
| Email to workers | Built (SMTP or Resend), not tested against a live provider. Without settings, messages stay in the outbox | SMTP settings or a Resend key in `.env` |
| Primary-source license checks | Not built | State board or vendor integration |
| Hosting | PostgreSQL, one server. Production mode refuses unsafe settings; `/healthz` for uptime checks. Documents are encrypted on the server's disk | Back up the database and `AEGIS_DATA/documents` together. Cloud document storage is deliberately not set up yet. Run one server only, because jobs run inside it |
| Security review | Basic controls only | Penetration test, SSO, BAAs and retention rules before real PHI or immigration data |
| Paid demand | Not testable in software | At least one paying external customer, per point 10 |
