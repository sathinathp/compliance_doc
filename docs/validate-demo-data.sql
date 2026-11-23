-- Aegis: queries to inspect and validate the data in PostgreSQL.
-- Run in pgAdmin: select the "aegis" database, open Tools > Query Tool,
-- highlight ONE query and press F5 (or the Run button) to see its result.
-- These queries only read data; none of them change anything.

-- 1. Every table and how many rows it has
SELECT table_name,
       (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text::int AS row_count
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;

-- 2. Companies (tenants). Expect 2: Bluebix Healthcare and Northstar Care
SELECT slug, name, kind, created_at
FROM tenants
ORDER BY name;

-- 3. Login accounts per company. Expect 6 for Bluebix and 5 for Northstar
SELECT t.name AS company, u.name, u.email, u.role
FROM users u
JOIN tenants t ON t.id = u.tenant_id
ORDER BY t.name, u.role;

-- 4. Workers. Expect the 8 from the mock HR system, plus any added with "New clinical hire"
SELECT t.name AS company, w.name, w.role, w.category, w.license_type, w.status, w.hire_date, w.readiness
FROM workers w
JOIN tenants t ON t.id = w.tenant_id
ORDER BY t.name, w.name;

-- 5. Where each worker is assigned (worker -> hospital/facility)
SELECT w.name AS worker, f.name AS facility, f.state, a.role, a.status, a.start_date
FROM assignments a
JOIN workers w ON w.id = a.worker_id
JOIN facilities f ON f.id = a.facility_id
ORDER BY w.name;

-- 6. Which rule packs each company has switched on
SELECT t.name AS company, tp.pack_key, tp.version, tp.status, tp.mode, u.name AS owner
FROM tenant_packs tp
JOIN tenants t ON t.id = tp.tenant_id
LEFT JOIN users u ON u.id = tp.owner_user_id
ORDER BY t.name, tp.pack_key;

-- 7. Current check results, counted per pack (Pass / Fail / Unknown / Not applicable)
SELECT pack_key, status, count(*) AS checks
FROM evaluations
WHERE is_current = 1
GROUP BY pack_key, status
ORDER BY pack_key, status;

-- 8. Every failing or unknown check, with the reason
SELECT e.pack_key, e.control_key, e.status, w.name AS worker, e.reason
FROM evaluations e
LEFT JOIN workers w ON w.id = e.subject_id
WHERE e.is_current = 1 AND e.status IN ('fail', 'unknown')
ORDER BY e.pack_key, w.name;

-- 9. Open cases (gaps being chased)
SELECT subject_name, pack_key, control_name, state, priority, due_date, reminders_sent, escalated
FROM cases
WHERE closed_at IS NULL
ORDER BY due_date;

-- 10. Closed cases and how they were closed
SELECT subject_name, control_name, closure, opened_at, closed_at, closure_evidence_id
FROM cases
WHERE closed_at IS NOT NULL
ORDER BY closed_at DESC;

-- 11. Documents (evidence) and their status. Watch for anything already expired
SELECT holder_name, doc_type, status, source, issued_on, expires_on,
       CASE WHEN expires_on IS NOT NULL AND expires_on < to_char(current_date, 'YYYY-MM-DD') THEN 'EXPIRED' ELSE '' END AS warning
FROM evidence
ORDER BY holder_name, doc_type;

-- 12. Messages that went out (reminders, requests) through the outbox
SELECT recipient, channel, subject, status, created_at
FROM messages
ORDER BY created_at DESC
LIMIT 50;

-- 13. Approvals waiting for a person
SELECT kind, title, status, pack_key, created_at
FROM approvals
ORDER BY created_at DESC;

-- 14. Latest audit log entries (the tamper-proof history)
SELECT seq, ts, type, subject, action, actor
FROM audit_log
ORDER BY seq DESC
LIMIT 50;

-- 15. Background jobs. Anything 'dead' or retrying means something failed
SELECT type, status, attempts, last_error, run_at
FROM jobs
WHERE status <> 'done'
ORDER BY run_at DESC;
