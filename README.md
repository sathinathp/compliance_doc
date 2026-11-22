# Aegis: AI Compliance Coworker MVP

The web workspace and backend for the 10-point plan. It needs Node 22.5 or newer. Run `npm install` once for the PostgreSQL and email packages.

## Run the Bluebix sandbox

```
npm run sandbox
```

Open http://127.0.0.1:4188 and select **Open Bluebix sandbox**. The sandbox runs the upgraded frontend and the normal backend with synthetic records. It uses its own SQLite database under `data/bluebix-sandbox`, and keeps delivery in the local outbox. The app's `.env` is ignored in sandbox mode.

- **Use a demo badge** lets you review the workspace as a specific Bluebix role.
- **Try empty company setup** opens Northstar, a separate blank sample tenant for testing spreadsheet onboarding.

Run the workflow tests with `npm test`.

## Try the milestone in the UI

1. Open the Bluebix sandbox. From the administrator account menu, choose **Demo controls**, then **New clinical hire**. This sends a signed webhook from the sample HRMS.
2. Open **Cases** to see the new cases.
3. Open **Connections**, find `Action needed: BLS provider card` for the new hire in the outbox, and click **Open link**.
4. Upload a text file like this one, using the new hire's name:
   ```
   Basic Life Support
   Name: Priya Nair, RN
   Card No: AHA-9
   Expiration Date: 2029-03-01
   ```
5. In **Cases**, choose **Closed** and open the case. It shows the verified closure, accepted evidence and current check result.
6. To exercise evidence review, submit a document with a mismatched name for a different open request.
7. In **Demo controls**, use **Advance 4 days** to exercise reminders and escalation. Use **Reset sandbox data** to restore the original test records before repeating the exercise.

## Turn on AI

Sign in as an administrator, open **Settings**, and paste a DeepSeek or Claude key under **AI Engine**. Aegis tests the key before saving it and stores it encrypted. You can put it in a `.env` file instead (see `.env.example`).

DeepSeek reads JPEG, PNG, GIF and WebP images but not scanned PDFs, so those go to human review. Fields that AI reads from an image always need a person to confirm them.

## How the code is organized

| Plan layer | File |
|---|---|
| Chat and web workspace | `public/`, `server/chat.js` |
| Connectors and compliance register | `server/connectors.js` |
| Pack registry | `server/registry.js`, `server/packs/*.json` |
| Event service and scheduler | `server/platform.js`, `server/index.js` |
| Control evaluator (no AI) | `server/evaluator.js` |
| Coworker orchestrator | `server/engine.js`, `server/chat.js`, `server/llm.js` |
| Action service | `server/engine.js` (`enqueueAction`, `sendAction`, `decide`) |
| Evidence and audit store | `server/evidence.js`, `server/platform.js` |
| Dashboards, reports, metrics | `server/views.js` |

To connect the real HRMS, see `docs/HRMS-CONNECTOR.md`. Field mapping is a connector setting, so it needs no code change.

## Prepare the live Bluebix pilot

1. Configure a dedicated PostgreSQL database, an HTTPS application URL, and a persistent document directory. Set `NODE_ENV=production`, `AEGIS_DEMO=0`, and a generated `AEGIS_SECRET` using `.env.example` as a reference. The production process checks these settings at startup.
2. Supply `AEGIS_PILOT_ADMIN_EMAIL`, `AEGIS_PILOT_ADMIN_NAME`, and a generated `AEGIS_PILOT_ADMIN_PASSWORD` of at least 16 characters in the provisioning process environment. Run `npm run provision:bluebix` against the pilot database. This creates an empty Bluebix workspace and its first administrator. Repeating the command with the same administrator leaves the existing password intact.
3. Start the application with `npm start`. `GET /healthz` checks database connectivity. Back up PostgreSQL, `AEGIS_DATA/documents`, and the encryption secret so they can be restored together.
4. In **Connections**, preview the live HRMS mapping before syncing, or import a reviewed roster. In **Company setup**, confirm the locations and activate the owner-approved healthcare pack in validation mode. Review the first assessment and confirm findings before enabling automatic requests.
5. Use the approved Slack or email test destination to verify delivery, worker upload links, evidence review and reporting before using worker records. See [HRMS setup](docs/HRMS-CONNECTOR.md) and [Slack setup](docs/SLACK-SETUP.md) for provider details.

See `docs/COMPLETE-WORKFLOW.md` for the gap analysis, the full workflow and what is still needed for production.
