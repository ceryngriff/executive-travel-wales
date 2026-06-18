# Executive Travel Wales — AI Chatbot

An embeddable AI chat widget for the Executive Travel Wales website. It answers
visitor questions and captures quote / booking requests, emailing them to the
business. The widget never holds the Claude API key — a Cloudflare Worker proxies
to the Anthropic Claude API and sends booking emails.

```
visitor → widget → Cloudflare Worker → Claude API → Worker → widget
                          └── on booking confirm → email to the business
```

## Layout

```
/widget/
  widget.js          # the embeddable widget (self-contained, no build step)
  demo.html          # offline demo page (scripted, no backend)
/worker/
  src/index.js       # Cloudflare Worker: /chat, /quote, /booking
  wrangler.toml      # Worker config
  .dev.vars.example  # example secrets/config for `wrangler dev`
README.md
```

## 1. Try the demo (no backend)

Open `widget/demo.html` in a browser (or serve the folder). The widget runs in
**demo mode**: a scripted conversation with a local copy of the pricing table, so
you can click through the look, the quote, and the full booking flow to a
confirmation without any backend or API key.

## 2. Deploy the Worker

Install Wrangler and authenticate:

```powershell
npm install -g wrangler
wrangler login
```

Set the secrets (run from the `worker/` folder):

```powershell
cd worker
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put RESEND_API_KEY
wrangler secret put BOOKING_TO_EMAIL
wrangler secret put BOOKING_FROM_EMAIL
```

Non-secret config (allowed origins, model, email provider, business facts) lives
in `wrangler.toml` under `[vars]` — edit it there. Fill in the `BUSINESS_*`
values; the `[PLACEHOLDER]` markers show what is still missing.

Run locally, then deploy:

```powershell
# Local: copy .dev.vars.example to .dev.vars and fill it in, then:
wrangler dev
# Production:
wrangler deploy
```

`wrangler deploy` prints your Worker URL, e.g.
`https://executive-travel-wales-chatbot.<subdomain>.workers.dev`.

### Email

Booking emails are sent via **Resend** by default (needs `RESEND_API_KEY` and a
verified `BOOKING_FROM_EMAIL` domain). To switch to MailChannels, set
`EMAIL_PROVIDER = "mailchannels"` in `wrangler.toml`. The provider lives behind a
single `sendBookingEmail()` function in `worker/src/index.js`.

## 3. Embed the widget

Host `widget/widget.js` somewhere public (your site, or the Worker's static
assets / a CDN), then add **one script tag**, pointing it at your Worker URL:

```html
<script src="https://YOURDOMAIN/widget/widget.js"
  data-worker-url="https://YOUR-WORKER-URL.workers.dev"
  data-accent="#c9a24b"
  data-greeting="Hi! Need a quote or have a question?"></script>
```

| Attribute            | Purpose                                            |
| -------------------- | -------------------------------------------------- |
| `data-worker-url`    | Deployed Worker base URL (no trailing slash)       |
| `data-accent`        | Accent colour (CSS colour)                         |
| `data-greeting`      | Greeting bubble / first message                    |
| `data-business-name` | Optional override of the header title              |
| `data-demo="true"`   | Force offline demo mode (no backend)               |

If `data-worker-url` is omitted, the widget runs in demo mode.

### Platform notes

- **Plain HTML / WordPress:** paste the snippet before `</body>` (in WordPress,
  a "Custom HTML" block, the theme footer, or a plugin like *Insert Headers and
  Footers*).
- **Wix:** Settings → Custom Code → add to the **Body – end** of all pages.
- **Squarespace:** Settings → Advanced → Code Injection → **Footer**.

Whichever platform, also add the site's real domain to `ALLOWED_ORIGINS` in
`wrangler.toml` (CORS is locked to it; `localhost` is allowed for development).

## Endpoints (Worker)

| Endpoint   | Body                                                                 | Returns |
| ---------- | -------------------------------------------------------------------- | ------- |
| `POST /chat`    | `{ messages: [{role, content}] }`                               | `{ reply }` — Claude's reply (system prompt + key added server-side; can call the quote engine). |
| `POST /quote`   | `{ pickup, destination, vehicleClass, passengers, returnTrip }` | `{ quotable:true, price, currency, breakdown, estimate:true, ... }` or `{ quotable:false, reason }`. |
| `POST /booking` | structured booking object (with `quote`)                       | `{ ok:true }` — validates and emails the business. |

Prices are never trusted from the client — `/quote` and the `get_quote` tool both
compute from the fixed-route table in the Worker.

## Pricing (Section 6.5)

Fixed-route table from a **single pickup in Merthyr Tydfil** to five airports ×
five vehicle classes, shown as an *"estimate, confirmed at booking"*. The table
figures are **return (round-trip) fares**; a **one-way** is half the return fare
plus 10% (return × 0.55), computed by the engine. Anything off the table (other
pickup, other destination) returns `quotable:false` → the bot promises a
personalised callback with the phone number.

> On some routes the 24-seater is priced **above** the 28-seater. This is
> intentional (the 24-seater is the more premium vehicle) — the values are used
> exactly as given.

Per-mile pricing is stubbed (`getDistanceMiles()` + `GOOGLE_MAPS_API_KEY`) so it
can be switched on later without rework. It is not used in v1.

## Security

- The Claude API key lives only in Worker secrets — never in `widget.js` or git.
- CORS is restricted to `ALLOWED_ORIGINS` (plus localhost for dev).
- Basic per-IP rate limiting and payload size limits on every endpoint.
- Inputs are validated; only the fields needed to email a booking are handled.
