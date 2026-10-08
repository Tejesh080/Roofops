# Pilot: what the owner configures personally

The database side is deployed (`evidence/pilot-release-deployment.md`). Two things need you: where the dashboard runs, and
two real staff logins. No password or secret belongs in chat, Git or this file.

## 1. Verified database TLS for the dashboard

The dashboard refuses any remote database it cannot verify. Give it the Supabase root CA in **one** of these ways.

**A. On this machine (how it runs today; no Vercel project is linked).** This is already done: `web/.env.local` holds
`DASHBOARD_DB_CA_CERT=D:/Claude/roofops/secrets/prod-ca-2021.crt`, proven live with `rejectUnauthorized=true`. To run the
pilot build:

```bash
npm --prefix web run build
```

```bash
npm --prefix web run start
```

Open http://127.0.0.1:3000. If the CA file ever moves, every page shows an error. The dashboard never falls back to an
unverified connection.

**B. On Vercel (if you deploy it there).** Project → Settings → Environment Variables (Production, mark them Sensitive):

- `DASHBOARD_DB_CA_PEM`: the CA with its newlines escaped. To put the escaped value on your clipboard without printing it,
  run this in PowerShell, then paste it into Vercel:

  ```powershell
  (Get-Content 'D:\Claude\roofops\secrets\prod-ca-2021.crt' -Raw) -replace "`r?`n", '\n' | Set-Clipboard
  ```

- Also `DASHBOARD_DATABASE_URL` (the `roofops_web` URL from `web/.env.local`), `AUTH_SECRET` (48+ random characters),
  `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL` and `DASHBOARD_DB_POOL_MAX=1`.

Then `cd web`, `npx vercel link` and `npx vercel deploy --prod`. Check that the sign-in page loads and pages show data.

**For a real staff pilot, leave `DEMO_USERNAME` and `DEMO_PASSWORD` unset** (or remove them from `web/.env.local`). The
shared demo login then disappears, and only individual staff logins work.

## 2. Two individual Finance/Admin staff accounts

Today the only FINANCE/ADMIN employee is **EMP-900 "Demo Finance Approver"**. That is the demo identity behind the
shared Airtable account, not a person. Leave it without a dashboard login. Add two real people instead, run from this
repository on your machine (it uses `SUPABASE_DB_URL` and verified TLS):

```bash
npm run staff:add-employee -- EMP-101 --name "First Person Full Name" --email first.person@yourcompany.com.au --role FINANCE
```

```bash
npm run staff:add-employee -- EMP-102 --name "Second Person Full Name" --email second.person@yourcompany.com.au --role ADMIN
```

Then **each person types their own password** (12–72 characters) at a hidden prompt on your machine. It is not echoed,
not stored in shell history, and cleared afterwards. In PowerShell, one person at a time:

```powershell
$s = Read-Host 'New dashboard password (12-72 characters)' -AsSecureString
$env:STAFF_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
npm run staff:set-password -- EMP-101 --login first.person
Remove-Item Env:STAFF_PASSWORD
```

(Repeat with `EMP-102 --login second.person`.) Each command signs that person out everywhere and writes one audit
row. Running it again resets that person's password.

**Check:**
- Each person signs in at the dashboard and the top bar shows their own name.
- Finance → "Invoice reissues" is visible to both. With no voided invoice, it shows "No voided final invoices".
- On Automation, both see "Mark resolved" (FINANCE and ADMIN may resolve). Only resolve a real exception when you mean
  to.
- Five wrong passwords lock that login for 10 minutes; `staff:set-password` unlocks it.

**Afterwards (optional):** once both people have logins, also require two people on the owner CLI:

```bash
npx tsx scripts/sql.ts "update app_settings set value = 'true' where key = 'invoice.reissue_requires_second_person'"
```

The dashboard already requires a second person in every case. Undo it by setting the value back to `false`.

## Still not part of this pilot setup

- **Airtable approvals:** these still come from the one shared Airtable account (mapped to EMP-900). Per-person Airtable
  approval needs Airtable seats and a mapping per person.
- **Creating the Xero draft after an approved reissue:** this stays the supervised operator dispatch
  (`npm run reissue -- dispatch --invoice INV-… --hosted`, with a short-lived token).
