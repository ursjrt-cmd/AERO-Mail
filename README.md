# AERO Mail — Resend-powered custom-domain webmail

A responsive Next.js webmail app with Supabase Auth, Postgres and private Storage, Resend's email sending API, Resend's Receiving API and signed `email.received` webhooks. It includes mailbox signup on administrator-enabled domains, inbox/sent/drafts/starred/archive/trash folders, message search, reply/forward composition, attachments and optional AI draft rewriting.

> **Architecture note:** this app provides a browser-based mailbox experience. Supabase stores each user's mailbox mapping, messages and attachments; Resend sends outgoing messages and receives inbound messages for configured domains, then calls this app's webhook. It is not a self-hosted SMTP/IMAP/POP mail server, and it does not provide traditional external mail-client access. Resend's newer native Inboxes product is currently described as private beta, so this implementation uses the documented Email API + Receiving API rather than depending on that beta.

## Included stack

- Next.js App Router + React + TypeScript
- Supabase Auth, Postgres and private Storage
- Resend Node SDK (`resend` 6.39.x): outbound email, inbound retrieval, attachment listing/download URLs and webhook signature verification
- Optional OpenAI Responses API for draft rewriting
- Vercel for the server runtime; GitHub for source control

GitHub Pages cannot run these server API routes or receive webhooks. Keep your source in GitHub and deploy this Next.js app to Vercel (or another Node.js host with HTTPS and webhook access).

## 1. Create Supabase project

1. Create a project at <https://supabase.com>.
2. Open **SQL Editor** and run `supabase/schema.sql`.
3. In **Authentication → URL Configuration**, set Site URL to `https://mail.aero.ist` and add `http://localhost:3000` plus your deployed callback URLs.
4. Copy the Project URL, anon/publishable key and service-role key. The service-role key is server-only. Never put it in a `NEXT_PUBLIC_` variable or commit it to GitHub.
5. Keep email confirmation enabled for public registration. Users sign up using a login/recovery email and request a mailbox address such as `j@aero.ist`. After they confirm and sign in, the app creates that address if its domain is enabled in `MAILBOX_ALLOWED_DOMAINS`.

## 2. Configure Resend for `aero.ist`

1. Create a Resend account at <https://resend.com> and create a **Full Access API key** for this application. A full-access key is needed by this implementation for sending and retrieving received email content/attachments. Keep it server-side.
2. In Resend → **Domains**, add `aero.ist` (or the exact domain users will send from). Resend generates account-specific DNS records. Add the exact records shown in your Resend dashboard; do not copy DNS values from another account or a tutorial.
3. Complete Resend's **sending verification** (SPF/return-path and DKIM records displayed by Resend). The sending API rejects unverified sender domains.
4. Enable **receiving** for `aero.ist` in Resend and add the MX record shown for inbound receiving. Sending and receiving are separate capabilities; a domain can be verified for one and not the other.
5. **Important for an existing email domain:** changing the MX record for `aero.ist` can redirect all new inbound mail for `@aero.ist` to Resend. If the domain currently has mailboxes hosted by Google Workspace, Zoho, Microsoft 365, Hostinger or another provider, do not replace its MX records until you have planned the migration. Resend documents receiving on a custom domain; check the receiving dashboard's exact MX instructions before changing DNS.
6. Add/verify SPF, DKIM and DMARC carefully. Do not publish multiple conflicting SPF TXT records at the same hostname; merge mechanisms into one SPF record where required. DMARC policy should be introduced deliberately and monitored.

Resend's `email.received` webhook payload is metadata. The webhook route in this app verifies the Svix signature against the **raw request body**, calls `resend.emails.receiving.get(emailId)` to retrieve text/HTML and recipient metadata, calls `resend.emails.receiving.attachments.list({ emailId })`, downloads attachment URLs returned by Resend and stores those files in the private Supabase bucket. Outgoing files are uploaded by the browser directly into the same private bucket under the signed-in user's temporary `outgoing/` folder; the authenticated server reads those objects and attaches them to the Resend send request. This avoids forwarding large file bodies through the Vercel API route. This is why both the `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` are required.

## 3. Environment variables

Copy `.env.example` to `.env.local` and configure all values locally and in Vercel → Project → Settings → Environment Variables.

- `NEXT_PUBLIC_SUPABASE_URL`: Supabase project URL.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Supabase anon/publishable key.
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key; server only.
- `NEXT_PUBLIC_APP_URL`: public website URL (for example `https://mail.aero.ist`).
- `NEXT_PUBLIC_MAILBOX_DEFAULT_DOMAIN`: default domain shown in signup (for example `aero.ist`).
- `MAILBOX_ALLOWED_DOMAINS`: domains the app may issue addresses on, only after setup and owner approval.
- `RESEND_SENDING_DOMAINS`: domains verified for sending in Resend.
- `RESEND_RECEIVING_DOMAINS`: domains with Resend receiving enabled and MX correctly configured.
- `RESEND_API_KEY`: Resend API key; server only. The send and receiving endpoints need an API key with the necessary permissions.
- `RESEND_WEBHOOK_SECRET`: signing secret for the webhook you create in Resend; starts with `whsec_`.
- `RESEND_FROM_NAME`: display name shown to recipients (default `AERO Mail`).
- `OPENAI_API_KEY`, `OPENAI_MODEL`: optional server-only AI rewriting integration.

For your first test, after `aero.ist` is verified for both sending and receiving, enable it explicitly in your private environment settings:

```env
NEXT_PUBLIC_MAILBOX_DEFAULT_DOMAIN=aero.ist
MAILBOX_ALLOWED_DOMAINS=aero.ist
RESEND_SENDING_DOMAINS=aero.ist
RESEND_RECEIVING_DOMAINS=aero.ist
RESEND_FROM_NAME=AERO Mail
```

Do not share API keys in chat, screenshots, GitHub issues or public repositories. If a secret is exposed, revoke/rotate it in its provider dashboard immediately.

## 4. Create the inbound webhook in Resend

After deploying the application to a public HTTPS URL:

1. Open Resend → **Webhooks** → **Add Webhook**.
2. Set endpoint URL to `https://mail.aero.ist/api/inbound`.
3. Select the `email.received` event.
4. Create the webhook and copy the webhook **signing secret** (`whsec_...`) into `RESEND_WEBHOOK_SECRET` in Vercel.
5. Redeploy after adding the secret.
6. Use Resend's webhook test/replay tools, or send a real message from an external account to a mailbox already registered in AERO Mail.

The endpoint acknowledges unrelated event types. For `email.received`, it verifies the signature, fetches the full received email via the Receiving API, resolves the delivered recipient against `mailboxes`, downloads supported attachments, and stores the message. Duplicate webhook deliveries are guarded by the `provider_message_id` unique index.

## 5. Create the first mailbox

1. Set `MAILBOX_ALLOWED_DOMAINS=aero.ist` after you control and configure the domain.
2. Deploy/restart the app.
3. On the sign-up page, register with a login/recovery email and request `j@aero.ist` (or another unused local part).
4. Confirm the login email, then sign in. The mailbox creation API maps the address to the authenticated Supabase user.
5. Send a test message from the AERO Mail compose window to an address you own. Resend only permits sending from a verified domain and may apply account/plan/recipient restrictions.
6. Reply to a test message from an external mailbox. Confirm the inbound webhook receives it and the message appears in AERO Mail.

Mailbox accounts here are **app accounts**: the Supabase user signs in with their independent recovery/login email, while the mailbox address is the email identity used by the site. A mailbox is not an independent password-authenticated IMAP account.

## 6. Add another custom domain

The Domain setup panel submits a request to the `domain_requests` table. It does not automatically buy a domain, verify DNS, create a Resend domain or approve mailbox issuance.

For each additional domain:

1. Verify that the requester controls the domain (an administrator should perform or review this step).
2. Add the domain in Resend and complete its sending and receiving DNS setup.
3. Add it to `MAILBOX_ALLOWED_DOMAINS`, `RESEND_SENDING_DOMAINS` and `RESEND_RECEIVING_DOMAINS` only after the corresponding capability is verified.
4. Redeploy the app. Users may then request addresses on that domain.

Never allow a user to register an address on a domain the business does not control. The current domain request panel is not a complete admin approval console or automated Resend domain-provisioning workflow. An administrator must review ownership, add the domain in Resend, verify DNS, and update the three allowlist environment variables before users can create mailboxes on it.

## 7. Run locally

Requires Node.js 20.9 or newer.

```bash
npm install
cp .env.example .env.local
# edit .env.local with real provider values
npm run dev
```

Open <http://localhost:3000>. `npm run lint` runs the TypeScript checker and `npm run build` creates the production build.

For local webhook testing, expose the dev server with a trusted HTTPS tunnel such as ngrok, then temporarily set the Resend webhook URL to `https://YOUR-TUNNEL/api/inbound`. Keep the webhook secret in `.env.local` only.

## 8. Deploy

1. Push the contents of the `aero-mail` folder to a private GitHub repository.
2. Import the repository into Vercel.
3. Add every environment variable from `.env.example` in Vercel. Do not add `.env.local` to GitHub.
4. Deploy, then add `mail.aero.ist` as a Vercel custom domain and create the DNS record Vercel displays.
5. Add `https://mail.aero.ist` to Supabase Auth Site URL and redirect URLs.
6. Create the Resend webhook at `https://mail.aero.ist/api/inbound`, subscribe to `email.received`, set `RESEND_WEBHOOK_SECRET`, and redeploy.
7. Send a test email from an external service to the registered AERO mailbox; verify the Resend receiving log, Vercel function log and Supabase `messages` row.

## Email/file behaviour and limits in this starter

- Outbound mail is sent with Resend's `emails.send` SDK method, plain text plus an escaped HTML alternative, Reply-To set to the mailbox address, and base64 attachments.
- Outbound messages are copied to the user's Sent folder after Resend accepts them.
- Inbound messages are fetched from Resend after webhook signature verification. The app stores safe plain text (HTML is converted to text if no text alternative exists) and does not render untrusted sender HTML in the reader.
- Incoming and outgoing attachments are stored in a private Supabase Storage bucket and downloaded using short-lived signed URLs after ownership checks. Outgoing uploads go directly from the browser to Supabase Storage, subject to bucket Storage policies; the Resend API request contains only attachment metadata and the server reads the private objects.
- Attachments are limited by this app to 15 MB per file, 20 MB combined and 10 files per message. Resend, Supabase Storage and your deployment plan may impose lower limits; check their current quotas before increasing these values.
- Resend API idempotency is supported when the caller supplies an `Idempotency-Key` request header; the UI serializes sends while one send is in progress.

## Important production hardening before opening public signup

This is a functional full-stack starter, not a finished commercial email-hosting provider. Keep `MAILBOX_ALLOWED_DOMAINS` empty until a controlled domain is verified and you are ready to provision users. Before public launch, add rate limiting and CAPTCHA, mailbox quotas and per-domain limits, a real administrator role/approval console, abuse reporting, bounce/complaint/suppression handling, message threading and conversation IDs, delivery-status UI, attachment malware scanning, strict MIME policy, backups, audit logs, monitoring, retention/deletion controls, privacy terms and a security review. Resend is an email API and receiving service, not an unrestricted general-purpose mailbox/SMTP/IMAP host. Check your Resend plan, account status, rate limits and sender policy before enabling many users.

## Official documentation

- [Resend Node.js SDK](https://github.com/resend/resend-node)
- [Resend email sending API](https://resend.com/docs/api-reference/emails/send-email)
- [Retrieve a received email](https://resend.com/docs/api-reference/emails/retrieve-received-email)
- [List received email attachments](https://resend.com/docs/api-reference/emails/list-received-email-attachments)
- [Retrieve a received email attachment](https://resend.com/docs/api-reference/emails/retrieve-received-email-attachment)
- [Resend webhook verification](https://resend.com/changelog/managing-webhooks-via-api)
- [Resend inbound email overview](https://resend.com/features/inbound)
