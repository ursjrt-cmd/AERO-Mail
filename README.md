# AERO Mail — single-file Render deployment

This edition consolidates the complete application into **one main source file: `server.js`**. It contains the responsive webmail interface, browser-side login flow, Express API, mailbox management, Resend send/receive integration, attachment handling, drafts, search, message actions, and optional AI email rewriting.

`package.json` is still required by Node/Render to install dependencies and start the application. `.env.example` is only a configuration reference. For local use, copy it to `.env.local`; the app loads `.env.local` automatically. There is no separate Next.js `app/`, `components/`, `lib/`, or SQL file in this edition.

## Stack

- Node.js 20.9+ (Node 22 recommended)
- Express
- Supabase Auth, Postgres, and private Storage
- Resend API and signed `email.received` webhook
- Optional OpenAI Responses API for email rewriting

## Local run (optional)

1. Copy `.env.example` to `.env.local` and fill in real credentials.
2. Run `npm install`.
3. Run `npm start` (or `npm run dev`).

## 1. Deploy on Render

Create or update a **Web Service** connected to the GitHub repository containing `server.js` and `package.json`.

- Runtime: Node
- Root Directory: blank if the two files are in the repository root
- Build Command: `npm install`
- Start Command: `npm start`
- Node version: 22 (set `NODE_VERSION=22` in Render if you need to pin it)

Do not deploy this as a Static Site. It needs a persistent Node web process for its API endpoints and inbound webhook.

## 2. Configure Supabase

Create/select a Supabase project. In Project Settings / API, copy the Project URL, anon/publishable key, and service-role/secret key.

Add these to Render Environment:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Then open the Supabase Dashboard's **Connect** panel, select **Session pooler**, and copy the connection string (shared pooler, port `5432`). Put the complete string in Render as `DATABASE_URL`. Replace the database password placeholder with your database password; URL-encode reserved characters in the password.

This application runs its own initial database setup on startup using `DATABASE_URL`: it creates the `mailboxes`, `messages`, and `domain_requests` tables and indexes if missing, and creates the private `mail-attachments` Storage bucket if it does not already exist. The Supabase service-role key is used only on the server. Never put it in browser code or a public repository.

In Supabase Authentication settings:

1. Enable Email sign-in.
2. Configure the Site URL to your Render URL while testing, then change it to `https://mail.aero.ist` after the custom domain works.
3. Add both the Render URL and `https://mail.aero.ist` to the allowed redirect URLs.
4. Configure email confirmation according to your preference. If confirmation is enabled, users must confirm their signup email before signing in.

## 3. Configure Resend

1. Create a Resend API key and put it in Render as `RESEND_API_KEY`.
2. Add `aero.ist` in Resend Domains.
3. Complete the DNS verification records shown in your Resend dashboard. Configure inbound receiving/MX records as shown by Resend if you intend to receive mail through this application.
4. Do not replace existing MX records until you have confirmed which mail service currently receives mail for `aero.ist`.

After Resend confirms the domain, set these Render variables (comma-separated if you enable more than one domain):

- `MAILBOX_ALLOWED_DOMAINS=aero.ist`
- `RESEND_SENDING_DOMAINS=aero.ist`
- `RESEND_RECEIVING_DOMAINS=aero.ist`
- `MAILBOX_DEFAULT_DOMAIN=aero.ist`

Set `RESEND_FROM_NAME=AERO Mail`.

### Resend webhook

After the Render service is deployed, create a Resend webhook with URL:

`https://mail.aero.ist/api/inbound`

Select the `email.received` event. Copy the webhook signing secret into Render as `RESEND_WEBHOOK_SECRET`, then redeploy/restart the Render service.

For initial testing before the custom domain is ready, use your actual `onrender.com` URL in the webhook URL. Change it to the custom domain after the custom domain is active.

## 4. Environment variables for Render

Add each key separately in Render → your Web Service → Environment:

| Key | Value |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon/publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role/secret key |
| `DATABASE_URL` | Supabase Session Pooler connection string (port 5432) |
| `RESEND_API_KEY` | Resend API key (`re_...`) |
| `RESEND_WEBHOOK_SECRET` | Resend webhook signing secret (`whsec_...`) |
| `RESEND_FROM_NAME` | `AERO Mail` |
| `MAILBOX_DEFAULT_DOMAIN` | `aero.ist` |
| `MAILBOX_ALLOWED_DOMAINS` | `aero.ist` after DNS verification |
| `RESEND_SENDING_DOMAINS` | `aero.ist` after Resend sending verification |
| `RESEND_RECEIVING_DOMAINS` | `aero.ist` after Resend receiving setup |
| `APP_URL` | Your current public Render/custom URL |
| `OPENAI_API_KEY` | Optional; leave empty to disable AI rewrite |
| `OPENAI_MODEL` | Optional; defaults to `gpt-4.1-mini` |

If migrating from the previous Next.js package, the application also accepts the previous `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `NEXT_PUBLIC_MAILBOX_DEFAULT_DOMAIN` names as fallback values. Prefer the new server variable names shown above.

## 5. Test the application

- Open `https://YOUR-SERVICE.onrender.com/health`. It should return JSON with `ok: true`.
- Open the website and create a test account.
- Create a mailbox only after the domain has been enabled in Render environment variables.
- Send a test message to an external address you control.
- Reply to the mailbox address and verify the Resend `email.received` webhook stores it in Inbox.
- Test attachments under the app's limits: 15 MB per file, 20 MB total, up to 10 files.

## Features

- Supabase email/password sign up and login
- Mailbox address creation on administrator-enabled domains
- Domain request submission
- Inbox, Starred, Sent, Drafts, Archive, and Trash
- Message search, open/read, star, archive, move to trash, and permanent delete from Trash
- Compose with To, Cc, Bcc, subject, rich text formatting, and attachments
- Draft save and resume
- Reply and forward helpers
- Resend outbound API with idempotency key
- Signed Resend inbound webhook, receiving API retrieval, inbound attachment download, and Supabase persistence
- Private attachment bucket and short-lived signed downloads
- Optional AI rewrite styles
- Responsive desktop/mobile design

## Important operational notes

- This creates webmail accounts stored in this application's Supabase database. It is not an IMAP/POP mailbox hosting server for external mail clients.
- A mailbox address is enabled only when its domain is listed in `MAILBOX_ALLOWED_DOMAINS`; outgoing and incoming messages also require the corresponding Resend domain allowlists.
- A domain request is stored in `domain_requests`. Approval is manual: verify the domain and then add it to the Render environment variables. The code does not automatically alter DNS or provision domains at Resend.
- Inbound email delivery depends on Resend receiving being available for your domain and its DNS records being correctly configured.
- The service-role key and database connection string are powerful secrets. Store them only in Render Environment. Never expose them in frontend code or commit them to GitHub.
- Render deploys may need a restart after changing environment variables.

## Verification status

`node --check server.js` passes. Package installation was attempted in the build environment but timed out, so dependencies were not fully installed here. I could not run an end-to-end production test against your real Supabase/Resend accounts. After configuring Render, verify the `/health` endpoint and perform the send/receive tests above before inviting users.
