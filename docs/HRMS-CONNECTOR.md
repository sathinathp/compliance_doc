# Connecting the real HRMS

Everything about the HRMS API is a setting, so connecting it needs no code change. Until the API key arrives, the demo uses the mock in `server/mock-hrms.js`.

## What to ask the HRMS team for

1. The base URL, for example `https://hrms.bluebix.com/api/v1`, and the path that lists workers, for example `/employees`.
2. How requests are authenticated: a bearer token, an API key in a header (and that header's name), or a username and password.
3. How results are split into pages: a "next cursor" in the response, page numbers, or everything in one response.
4. Whether the list can return only records changed since a time or cursor, and the name of that parameter.
5. One sample response with two or three workers.
6. Whether they can send webhooks when a worker is added, changes assignment or leaves.

## Steps once you have the key

An administrator can open **Connections → Add HRMS connection**, enter the URL, authentication and mapping settings, and select **Test mapping**. Review the sample results, select **Test and save**, then use **Sync now**. For automation or webhook setup, use the API calls below with a JSON body.

1. **Test first:** `POST /api/connectors/test` with the settings. Nothing is saved. The answer shows how many records were read, every field name the HRMS sent (`source_fields`), the first five workers as Aegis would store them, and any field Aegis could not find (`fields_never_found`).
2. **Fix the mapping:** if a field is missing, add it to `field_map` and test again. For example, `"name": "person.displayName"`.
3. **Save:** `POST /api/connectors` with the same settings.
4. **First sync:** `POST /api/connectors/<id>/sync`. After this, a sync runs once a day by itself.
5. **Webhooks (optional):** `POST /api/connectors/webhook-secret` returns the webhook URL and a signing secret. Give both to the HRMS team. The secret is shown only once.

## Example settings

```json
{
  "name": "Bluebix HRMS",
  "base_url": "https://hrms.bluebix.com/api/v1",
  "path": "/employees",
  "auth_type": "header",
  "auth_header": "X-API-Key",
  "api_key": "…",
  "pagination": "page",
  "page_size": 100,
  "list_field": "data",
  "incremental": "last_sync",
  "since_param": "updated_since",
  "field_map": { "external_id": "employeeId", "name": "displayName", "email": "workEmail", "facility": "location.name" }
}
```

## All settings

| Setting | Default | Meaning |
|---|---|---|
| `base_url` | required | The API's address. Must be `https://` in production |
| `path` | `/workers` | The endpoint that lists workers |
| `auth_type` | `bearer` | `bearer`, `header`, `basic` or `none` |
| `api_key` | required, unless `basic` or `none` | Stored encrypted and never shown again |
| `auth_header` | | Header name when `auth_type` is `header` |
| `username`, `password` | | For `auth_type` `basic` |
| `pagination` | `cursor` | `cursor` follows the next cursor, `page` counts pages, `none` makes one request |
| `page_param`, `page_size_param`, `page_size`, `first_page` | `page`, `per_page`, none, `1` | For `pagination` `page` |
| `cursor_field` | `next_cursor` | Where the response puts the next cursor. Dotted paths are allowed |
| `incremental` | `cursor` | `cursor` sends the saved cursor, `last_sync` sends the last sync time, `none` reads everything each time |
| `since_param` | `since` | The parameter for incremental syncs |
| `list_field` | auto-detected | Where the list of workers is in the response, for example `data.items` |
| `field_map` | see `DEFAULT_PATHS` in `server/connectors.js` | Where each Aegis field is in a record |
| `terminated_values` | `terminated, separated, resigned, former, ended` | Status values that mean the person has left |
| `timeout_ms` | `20000` | Time limit for each request |
| `webhook_signature_header` | `X-Aegis-Signature` | The header the HRMS signs webhooks in |

Fields you can map: `external_id`, `name`, `first_name`, `last_name`, `email`, `slack_id`, `role`, `category`, `dept`, `license_type`, `entity`, `status`, `hire_date`, `work_auth_expires`, `facility`, `facility_state`, `assignment_start` and `attrs`.

## Safety rules

- A record with no name, or with neither an id nor an email, is skipped and reported, never guessed. The skip count appears in the sync result and on the connector.
- Syncing the same data twice creates no duplicates.
- A webhook without a full worker record starts a sync, so Aegis reads the full record rather than storing half of one.
- Changing settings keeps the saved key unless you send a new one. Keys never appear in API answers or in the audit log.
- Other routes: `GET /api/connectors` lists connectors, `POST /api/connectors/<id>` changes settings, `/test` tests saved settings, `/disable` and `/enable` turn one off and on, and `/full-resync` reads every worker again.
