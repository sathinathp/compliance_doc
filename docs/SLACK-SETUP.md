# Connecting Slack

An administrator connects Slack on **Integrations** in the Aegis web app. Nobody edits files on the server. It takes about 15 minutes.

## 1. Create the Slack app

1. Go to **api.slack.com/apps** and choose **Create New App → From a manifest**.
2. Pick the workspace. For a first test, use a free workspace of your own.
3. Paste this manifest and choose **Create**:

```yaml
display_information:
  name: Aegis
  description: AI compliance coworker
features:
  bot_user:
    display_name: Aegis
    always_online: true
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - app_mentions:read
      - im:history
      - im:read
      - im:write
      - users:read
      - users:read.email
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
  socket_mode_enabled: true
```

## 2. Copy the keys

| Key | Where | Looks like |
|---|---|---|
| Bot token | **Install App → Install to Workspace**, then *Bot User OAuth Token* | `xoxb-…` |
| App token | **Basic Information → App-Level Tokens → Generate Token**, with the scope `connections:write` | `xapp-…` |
| Signing secret (optional) | **Basic Information → App Credentials** | random text |

## 3. Connect in Aegis

1. Sign in as an administrator and open **Company → Integrations**.
2. Choose **Connect Slack**, then paste the bot token and the app token.
3. Enter the alerts channel, for example `#compliance-alerts`.
4. Choose **Test & save**. Aegis checks the keys with Slack before saving them.
5. In Slack, open the alerts channel and type `/invite @Aegis`.
6. Choose **Send test message**. A message appears in the channel.

## What Slack is used for

- **Alerts and digests** go to the alerts channel.
- **Requests and reminders** go to each person as a direct message. Aegis finds them by their work email, so nobody copies Slack IDs. Someone who is not in Slack gets email, or the message stays in the outbox.
- **Chat:** direct-message Aegis to ask a read-only question such as "What needs my approval?". Aegis matches the Slack account to an Aegis user and applies that user's permissions. A channel mention points people to a private conversation. Open **Ask coworker** in the Aegis workspace to preview and confirm follow-ups or save dashboards.

## Two ways for Slack to reach Aegis

- **Socket Mode (the app token, recommended for now).** Aegis opens the connection to Slack, so chat works with no public address, even on a laptop.
- **Events URL (the signing secret).** Slack calls `https://<your Aegis address>/api/webhooks/slack/<company>`. This needs Aegis on a public https address. The exact URL is shown under *Advanced* in the Connect dialog.

## Security

- Keys are stored encrypted with `AEGIS_SECRET` and never sent back to the browser. The page shows only the first and last few characters.
- Each company has its own Slack connection.
- Connecting, replacing, testing and disconnecting are all recorded in the audit log, without the keys.
- For local development, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` and `SLACK_SIGNING_SECRET` in `.env` still work. Keys saved on the Integrations page take priority.

## Microsoft Teams

Teams shows as *Coming soon* on the Integrations page. It will need an **App ID**, a **Client secret** and a **Tenant ID**. A Microsoft 365 administrator creates these by registering the Aegis bot in the Teams Developer Portal.
