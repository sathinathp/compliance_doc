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

In **Settings → AI Engine**, an administrator can connect DeepSeek, Claude, OpenAI, Google Gemini, OpenRouter, Groq, or Mistral AI. Each workspace uses one active provider. For OpenAI-compatible providers, enter a model ID that supports function calling. **Test & save** checks the connection with a sample prompt and stores the key encrypted after a successful test. For server-wide DeepSeek or Claude defaults, see `.env.example`.

Open **Ask coworker** from the top bar to ask about checks, workers, credentials, cases, or approvals. The coworker can keep the topic across turns in the same conversation, such as changing a date window or narrowing checks to a pack, and it offers relevant follow-up questions. Recognized questions use Aegis queries directly. For an unmatched question, a configured AI provider can interpret the latest message using up to three recent user questions and the current topic. Stored coworker answers and record query results stay in Aegis. The provider can write product guidance or ask for clarification. Permissions, record answers, dashboard creation, and confirmed evidence follow-ups are handled by Aegis. Slack direct messages are read-only.

Use **New chat** in the coworker popup to start a separate conversation and **History** to return to an earlier one. A role change starts a new chat history for that account. Legacy messages saved before access versions were introduced are hidden. In **Settings → Coworker policy**, administrators can switch off new replies, follow-ups, dashboard creation, or Slack DMs, and set chat retention and a workspace-wide daily limit for coworker AI requests. Blank limits preserve the existing retention and usage defaults. A zero AI limit turns off provider classification. Direct record queries still work, and the chat limit is separate from document extraction. Usage resets at midnight UTC, and attempts to reach the provider count toward the limit.

For **Custom OpenAI-compatible**, enter the full HTTPS Chat Completions endpoint. The Aegis server operator adds trusted endpoints to the comma-separated `AEGIS_LLM_CUSTOM_ENDPOINTS` setting before a workspace can use them.

For compatible providers, enable document images only when the selected model supports image input. Claude supports scanned PDFs. With other providers, scanned PDFs go to human review. Fields read from an image still need a person to confirm them.

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
3. Start the application with `npm start`. `GET /healthz` checks database connectivity. Only one server may run per database: a second one refuses to start, because both would run the same background jobs and send messages twice.
4. In **Connections**, preview the live HRMS mapping before syncing, or import a reviewed roster. In **Company setup**, confirm the locations and activate the owner-approved healthcare pack in validation mode. Review the first assessment and confirm findings before enabling automatic requests.
5. Use the approved Slack or email test destination to verify delivery, worker upload links, evidence review and reporting before using worker records. See [HRMS setup](docs/HRMS-CONNECTOR.md) and [Slack setup](docs/SLACK-SETUP.md) for provider details.

## Backups and restore

The server makes a backup once a day: every database table and the stored documents, in a dated folder under `AEGIS_DATA/backups` (or `AEGIS_BACKUP_DIR`). The newest 14 are kept.

- Make one now: `npm run backup` (add `-- --dir D:\aegis-backups` to choose the folder).
- Restore: stop the server, then `npm run restore -- <backup folder>`. The database must be empty; add `--replace` to delete what is there first. Everyone signs in again afterwards.

The encryption key (`AEGIS_SECRET`, or `AEGIS_DATA/.secret`) is never put in a backup. Keep it somewhere separate and safe: without the same key, restored documents and saved connector keys cannot be read, and the restore warns you if the key does not match. Copy the backup folder off the computer too; a backup on the same disk does not survive a disk failure.

## Users

Administrators manage people in **Settings → Users & Roles**: change a role (it applies straight away), reset a password (the person is signed out everywhere), or deactivate someone who has left (signed out at once, no sign-in or Slack chat, history kept; reactivate any time). Nobody can deactivate themselves or change their own role. Everyone can change their own password from the account menu. Passwords need at least 12 characters.

See `docs/COMPLETE-WORKFLOW.md` for the gap analysis, the full workflow and what is still needed for production.
