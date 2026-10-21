# Executive Travel Wales

Website and AI booking assistant for Executive Travel Wales, a minibus and coach hire service based in Merthyr Tydfil and covering Cardiff, Swansea, Newport and the rest of South Wales.

Live site: [executivetravel.wales](https://executivetravel.wales)

## Overview

The project has two parts:

1. **Marketing website.** A fast, SEO-focused static site with dedicated pages for airport transfers, corporate hire, event transport and minibus hire.
2. **AI chat assistant.** An embeddable chat widget backed by a Cloudflare Worker. It answers customer questions, calculates fixed-route quotes and passes confirmed bookings to the business by email and into the company's booking system.

```
visitor → chat widget → Cloudflare Worker → Claude API
                              ├── quote engine (fixed-route pricing)
                              ├── booking email (Resend)
                              └── booking intake API (Evans Taxi app)
```

## Tech stack

| Area | Technology |
| --- | --- |
| Website | HTML5, CSS3, vanilla JavaScript |
| Hosting and performance | Apache `.htaccess` (GZIP, caching, HTTPS and clean URL rewrites), sitemap and robots.txt |
| Chat widget | Self-contained JavaScript, no build step |
| Backend | Cloudflare Workers, Workers KV for conversation memory |
| AI | Anthropic Claude API with tool use for quoting |
| Integrations | Resend (email), Facebook Messenger webhook |

## Features

- Responsive service pages with structured, search-friendly content
- Chat assistant that quotes prices server-side, so prices can never be altered from the browser
- Booking capture with validation, emailed to the business and sent to the booking system
- Facebook Messenger support using the same assistant
- Security measures: API keys held only as Worker secrets, CORS locked to approved domains, per-IP rate limiting and payload size limits

## Project structure

```
├── index.html, *.html     Website pages
├── css/, js/, assets/     Styles, scripts and images
├── widget/                Embeddable chat widget and offline demo
├── worker/                Cloudflare Worker (chat, quote and booking endpoints)
└── docs/
    ├── CHATBOT.md         Setup, deployment and API reference for the chat assistant
    └── marketing/         SEO, performance and directory listing notes
```

## Running locally

**Website:** open `index.html` in a browser, or serve the folder with any static server.

**Chat widget demo:** open `widget/demo.html`. It runs a scripted demo without any backend or API key.

**Worker:** see [docs/CHATBOT.md](docs/CHATBOT.md) for Wrangler setup, secrets and deployment.

## Author

Built by [Ceryn Griffiths](https://github.com/ceryngriff).
