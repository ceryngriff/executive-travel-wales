// Executive Travel Wales — Cloudflare Worker backend proxy.
//
// Endpoints:
//   POST /chat    — proxies the conversation to the Claude Messages API. The system
//                   prompt + API key are added here so they never reach the browser.
//                   Claude can call the get_quote tool, which runs the deterministic
//                   quoting engine below (Section 6.5 of the build brief).
//   POST /quote   — runs the quoting engine directly (the widget can also call this).
//   POST /booking — validates a structured booking and emails it to the business.
//
// Secrets / vars (wrangler secret put / .dev.vars):
//   ANTHROPIC_API_KEY, RESEND_API_KEY, BOOKING_TO_EMAIL, BOOKING_FROM_EMAIL,
//   ALLOWED_ORIGINS, EMAIL_PROVIDER (default "resend"), CLAUDE_MODEL,
//   BUSINESS_* fact fields, and (later, for per-mile pricing) GOOGLE_MAPS_API_KEY.

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_MESSAGES = 30;
const MAX_BODY_BYTES = 32_000;
const MAX_BOOKING_FIELD_LENGTH = 800;
const MAX_TOOL_ROUNDS = 4;

// ---------------------------------------------------------------------------
// Quoting engine (Section 6.5). Deterministic lookup — the LLM only gathers
// inputs and reads back the result. All prices GBP, single pickup. The table
// figures are RETURN (round-trip) fares; one-way is derived (see ONE_WAY_FACTOR).
// ---------------------------------------------------------------------------

const CURRENCY = 'GBP';
const PICKUP_POINT = 'Merthyr Tydfil';
// One-way = half the return fare, plus 10% (i.e. return x 0.55).
const ONE_WAY_FACTOR = 0.55;

const VEHICLE_CLASSES = {
  car: { label: 'Executive car', maxPassengers: 3 },
  '8_seater': { label: '8-seater', maxPassengers: 8 },
  '16_seater': { label: '16-seater minibus', maxPassengers: 16 },
  '24_seater': { label: '24-seater coach', maxPassengers: 24 },
  '28_seater': { label: '28-seater coach', maxPassengers: 28 },
};

// From Merthyr Tydfil → destination airport, RETURN (round-trip) fare per vehicle class.
// NOTE: on some routes the 24-seater is priced ABOVE the 28-seater. This is
// INTENTIONAL — the 24-seater is a more premium vehicle. Do not "correct" it.
const FIXED_ROUTES = {
  Bristol: { car: 260, '8_seater': 300, '16_seater': 440, '24_seater': 700, '28_seater': 650 },
  Cardiff: { car: 180, '8_seater': 220, '16_seater': 340, '24_seater': 450, '28_seater': 400 },
  Birmingham: { car: 400, '8_seater': 450, '16_seater': 650, '24_seater': 850, '28_seater': 750 },
  Heathrow: { car: 500, '8_seater': 600, '16_seater': 800, '24_seater': 1000, '28_seater': 1200 },
  Gatwick: { car: 600, '8_seater': 750, '16_seater': 900, '24_seater': 1200, '28_seater': 1400 },
};

// Map of normalised aliases → canonical destination key in FIXED_ROUTES.
const DESTINATION_ALIASES = {
  lhr: 'Heathrow',
  'london heathrow': 'Heathrow',
  lgw: 'Gatwick',
  'london gatwick': 'Gatwick',
  brs: 'Bristol',
  cwl: 'Cardiff',
  bhx: 'Birmingham',
};

function normalise(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchDestination(destination) {
  const norm = normalise(destination);
  if (!norm) return null;
  if (DESTINATION_ALIASES[norm]) return DESTINATION_ALIASES[norm];
  for (const key of Object.keys(FIXED_ROUTES)) {
    if (norm.includes(key.toLowerCase())) return key;
  }
  for (const [alias, key] of Object.entries(DESTINATION_ALIASES)) {
    if (norm.includes(alias)) return key;
  }
  return null;
}

function isMerthyrPickup(pickup) {
  const norm = normalise(pickup);
  return norm.includes('merthyr');
}

function parseReturnTrip(returnTrip) {
  if (typeof returnTrip === 'boolean') return returnTrip;
  const norm = normalise(returnTrip);
  if (!norm) return false;
  if (/^(no|n|one way|single|not)/.test(norm)) return false;
  return /(yes|y|return|round|both ways|two way|2 way)/.test(norm);
}

const CUSTOMER_AWARENESS = [
  'Prices are based on one pickup point in Merthyr Tydfil.',
  'This is an estimate, confirmed at booking.',
  'Extra pickups or a different start point need a custom quote.',
];

// Returns { quotable: true, price, currency, breakdown, estimate, ... }
// or { quotable: false, reason }.
function computeQuote(input = {}) {
  const { pickup, destination, vehicleClass, passengers, returnTrip } = input;

  if (!isMerthyrPickup(pickup)) {
    return {
      quotable: false,
      reason:
        'Listed prices are for journeys starting in Merthyr Tydfil only. For any other pickup point the team will send a personalised quote.',
    };
  }

  const destKey = matchDestination(destination);
  if (!destKey) {
    return {
      quotable: false,
      reason:
        'That destination is not on our fixed-route price list (Bristol, Cardiff, Birmingham, Heathrow or Gatwick airports). The team will send a personalised quote.',
    };
  }

  const vehicle = VEHICLE_CLASSES[vehicleClass];
  if (!vehicle) {
    return {
      quotable: false,
      reason:
        'Please choose a vehicle class: Executive car, 8-seater, 16-seater minibus, 24-seater coach or 28-seater coach.',
    };
  }

  const paxNumber = Number.parseInt(passengers, 10);
  if (Number.isFinite(paxNumber) && paxNumber > vehicle.maxPassengers) {
    return {
      quotable: false,
      reason: `A ${vehicle.label} seats up to ${vehicle.maxPassengers} passengers. Please choose a larger vehicle for ${paxNumber} passengers.`,
    };
  }

  const returnFare = FIXED_ROUTES[destKey][vehicleClass];
  const isReturn = parseReturnTrip(returnTrip);
  const price = isReturn ? returnFare : Math.round(returnFare * ONE_WAY_FACTOR);

  const breakdown = isReturn
    ? [
        `${vehicle.label}: Merthyr Tydfil to ${destKey} Airport (return)`,
        `Return fare: £${returnFare}`,
      ]
    : [
        `${vehicle.label}: Merthyr Tydfil to ${destKey} Airport (one-way)`,
        `One-way fare: £${price}`,
      ];

  return {
    quotable: true,
    price,
    currency: CURRENCY,
    estimate: true,
    pickup: PICKUP_POINT,
    destination: `${destKey} Airport`,
    vehicleClass,
    vehicleLabel: vehicle.label,
    returnTrip: isReturn,
    returnFare: isReturn ? returnFare : undefined,
    breakdown,
    awareness: CUSTOMER_AWARENESS,
  };
}

// Stub for future per-mile pricing. Not used in v1 (fixed-route table only).
// Keeps the seam so per-mile pricing can be switched on without rework.
// eslint-disable-next-line no-unused-vars
async function getDistanceMiles(origin, destination, env) {
  if (!env || !env.GOOGLE_MAPS_API_KEY) return null;
  // Intentionally not implemented for v1 — see build brief Section 3.
  return null;
}

// ---------------------------------------------------------------------------
// Rate limiting (basic, per-IP, in-memory).
// ---------------------------------------------------------------------------

const rateLimitStore = new Map();

function getClientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    'unknown'
  );
}

function enforceRateLimit(request) {
  const ip = getClientIp(request);
  const now = Date.now();
  const recent = (rateLimitStore.get(ip) || []).filter(
    (ts) => now - ts < RATE_LIMIT_WINDOW_MS
  );
  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitStore.set(ip, recent);
    return false;
  }
  recent.push(now);
  rateLimitStore.set(ip, recent);
  return true;
}

// ---------------------------------------------------------------------------
// CORS + responses.
// ---------------------------------------------------------------------------

const LOCAL_ORIGINS = [
  'http://localhost:8787',
  'http://127.0.0.1:8787',
  'http://localhost:8788',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'null', // file:// pages (local demo.html) report Origin: null
];

function allowedOrigins(env) {
  const configured = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured.concat(LOCAL_ORIGINS) : LOCAL_ORIGINS;
}

function isOriginAllowed(origin, env) {
  if (!origin) return false;
  return allowedOrigins(env).includes(origin);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(body, status = 200, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', ...corsHeaders(origin) },
  });
}

function textResponse(text, status = 200, origin) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...corsHeaders(origin) },
  });
}

async function readJson(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw new Error('Payload too large.');
  }
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// System prompt.
// ---------------------------------------------------------------------------

function businessFacts(env) {
  return {
    BUSINESS_NAME: 'Executive Travel Wales',
    TAGLINE: env.BUSINESS_TAGLINE || '[TAGLINE]',
    PHONE: env.BUSINESS_PHONE || '[PHONE]',
    EMAIL: env.BUSINESS_EMAIL || '[EMAIL]',
    HOURS: env.BUSINESS_HOURS || '[HOURS]',
    AREAS_COVERED: env.BUSINESS_AREAS || '[AREAS_COVERED]',
    SERVICES: env.BUSINESS_SERVICES || '[SERVICES]',
    FLEET: env.BUSINESS_FLEET || '[FLEET]',
    AIRPORTS: env.BUSINESS_AIRPORTS || '[AIRPORTS]',
    PRICING_POLICY:
      env.BUSINESS_PRICING_POLICY ||
      'Live estimates via the quoting engine for fixed Merthyr Tydfil → airport routes; everything else is a personalised callback.',
    BOOKING_NOTES: env.BUSINESS_BOOKING_NOTES || '[BOOKING_NOTES]',
  };
}

function buildSystemPrompt(env) {
  const f = businessFacts(env);
  return `You are the virtual assistant for ${f.BUSINESS_NAME}. Be warm, friendly and welcoming, with a personable and genuinely helpful tone, while staying professional and concise. A little friendliness and the occasional emoji are great. Use British English. Never use em dashes or en dashes anywhere in your replies; use commas, full stops or brackets instead.

ROLE
- You do two jobs: answer questions about the business, and help visitors get a quote or booking.
- Answer questions using ONLY the business facts below. If you do not know something, say the team will follow up and give the phone number (${f.PHONE}).
- Stay on topic: travel and bookings for this business. Politely decline unrelated requests.
- Always keep the phone number available as a fallback.
- Never invent prices, vehicles, policies or availability.

BUSINESS FACTS
- Name: ${f.BUSINESS_NAME}
- Tagline: ${f.TAGLINE}
- Phone: ${f.PHONE}
- Email: ${f.EMAIL}
- Hours: ${f.HOURS}
- Areas covered: ${f.AREAS_COVERED}
- Services: ${f.SERVICES}
- Fleet: ${f.FLEET}
- Airports: ${f.AIRPORTS}
- Pricing policy: ${f.PRICING_POLICY}
- Booking notes: ${f.BOOKING_NOTES}

PRICING. Use the get_quote tool, never your own guess.
- Fixed prices are available ONLY for journeys that START in Merthyr Tydfil and go to one of these airports: Bristol, Cardiff, Birmingham, Heathrow, Gatwick.
- Vehicle classes: car (Executive car, up to 3), 8_seater (up to 8), 16_seater (16-seater minibus), 24_seater (24-seater coach), 28_seater (28-seater coach).
- Listed fares are for a RETURN (round-trip) journey; the get_quote tool also returns the correct one-way price. Always read back the tool's figure. NEVER work out or explain how a price is calculated, and never mention any percentages, multipliers or formulas. Just state the price.
- When a visitor asks "how much" or shows booking intent, state up front that listed prices are from a single pickup point in Merthyr Tydfil, then gather: pickup, destination airport, vehicle class, passengers, date/time and whether it is a return or one-way trip.
- Once you have pickup, destination, vehicle class and return-or-one-way, CALL the get_quote tool. Read back the figure it returns as an estimate.
- When you give a quote, also state in your own words that it is based on one pickup point in Merthyr Tydfil and is an estimate confirmed at booking. Do not explain how the price was worked out.
- If get_quote returns quotable:false, do NOT guess a price. Tell the visitor the team will send a personalised quote and give the phone number.
- The visitor can change details (e.g. vehicle class) and you re-quote.

BOOKING
- After a quote, offer to take the booking. Collect, one question at a time, confirming as you go: service type; date & time; pickup; destination; passengers (plus luggage / child seats if relevant); return or one-way; IF it is a return trip, also ask for the customer's return flight number so we can track the inbound flight for the pickup; name; contact email and/or phone; any notes.
- When you have everything, show a short summary INCLUDING the quoted estimate, mention that a £25 deposit is required to secure the booking, and ask the visitor to confirm.
- ONLY when the visitor confirms, end your message with a single booking block on its own line, exactly in this format (the website reads it and emails the team; the visitor does not see the raw block):
[[BOOKING]]{"serviceType":"...","dateTime":"...","pickupLocation":"...","destination":"...","vehicleClass":"...","passengers":"...","returnTrip":"...","flightNumber":"...","name":"...","contact":"...","notes":"...","quote":{"price":0,"currency":"GBP","estimate":true,"quotable":true}}[[/BOOKING]]
  Use the real collected values. If a field is unknown use an empty string (leave flightNumber empty for one-way trips). If no quote was produced, set "quote" to null. Put a warm, friendly confirmation message BEFORE the block that tells the visitor a member of the Executive Travel Wales team will check availability and get back to them shortly, that a £25 deposit is required to secure the booking, and gives the phone number for anything urgent (e.g. "Brilliant, thank you so much! 😊 A member of our Executive Travel Wales team will check availability and get back to you very soon. Please note a £25 deposit is required to secure your booking. If you need anything in the meantime, just give us a call on ${f.PHONE}."). Do not output the block until the visitor has confirmed.`;
}

// ---------------------------------------------------------------------------
// Claude tool definition + call.
// ---------------------------------------------------------------------------

const QUOTE_TOOL = {
  name: 'get_quote',
  description:
    'Look up a live fixed-route price estimate for a journey that starts in Merthyr Tydfil and ends at an airport. Always call this before stating any price; never invent or adjust prices. Returns quotable:false (with a reason to read back) when the trip is off the fixed-route table.',
  input_schema: {
    type: 'object',
    properties: {
      pickup: {
        type: 'string',
        description: 'Pickup location. Fixed prices are only available from Merthyr Tydfil.',
      },
      destination: {
        type: 'string',
        description: 'Destination airport: Bristol, Cardiff, Birmingham, Heathrow or Gatwick.',
      },
      vehicleClass: {
        type: 'string',
        enum: ['car', '8_seater', '16_seater', '24_seater', '28_seater'],
        description: 'Vehicle class id.',
      },
      passengers: { type: 'integer', description: 'Number of passengers.' },
      returnTrip: { type: 'boolean', description: 'True if a return trip is requested.' },
      dateTime: { type: 'string', description: 'Requested date and time (free text).' },
    },
    required: ['pickup', 'destination', 'vehicleClass'],
  },
};

async function callAnthropic(env, systemPrompt, messages) {
  const model = env.CLAUDE_MODEL || DEFAULT_MODEL;
  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      tools: [QUOTE_TOOL],
      messages,
    }),
  });
  return response;
}

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// /chat
// ---------------------------------------------------------------------------

// Runs Claude over `messages` (mutated in place with the tool rounds) and returns
// the assistant's final text. Shared by /chat (website) and /messenger (Facebook).
// Throws on a hard API failure.
async function runClaudeConversation(env, messages) {
  const systemPrompt = buildSystemPrompt(env);
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await callAnthropic(env, systemPrompt, messages);
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Anthropic ${response.status}: ${detail}`);
    }
    const data = await response.json();
    messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of data.content || []) {
        if (block && block.type === 'tool_use' && block.name === 'get_quote') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(computeQuote(block.input || {})),
          });
        }
      }
      if (toolResults.length === 0) return extractText(data.content);
      messages.push({ role: 'user', content: toolResults });
      continue;
    }
    return extractText(data.content);
  }
  return 'Sorry, I had trouble completing that. Please call us and the team will help.';
}

// Pulls a [[BOOKING]]{...}[[/BOOKING]] block out of an assistant reply.
const BOOKING_BLOCK_RE = /\[\[BOOKING\]\]([\s\S]*?)\[\[\/BOOKING\]\]/;
function extractBooking(text) {
  const match = text.match(BOOKING_BLOCK_RE);
  if (!match) return { clean: text, booking: null };
  let booking = null;
  try { booking = JSON.parse(match[1].trim()); } catch (e) { booking = null; }
  return { clean: text.replace(BOOKING_BLOCK_RE, '').trim(), booking };
}

async function handleChat(request, env, origin) {
  if (!enforceRateLimit(request)) {
    return jsonResponse({ error: 'Rate limit exceeded. Please wait a moment.' }, 429, origin);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'Chat is not configured (missing API key).' }, 500, origin);
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    const tooLarge = /too large/i.test(error.message || '');
    return jsonResponse({ error: tooLarge ? 'Message too large.' : 'Invalid request.' }, tooLarge ? 413 : 400, origin);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonResponse({ error: 'A non-empty messages array is required.' }, 400, origin);
  }
  if (body.messages.length > MAX_MESSAGES) {
    return jsonResponse({ error: 'Conversation is too long.' }, 400, origin);
  }

  const messages = [];
  for (const message of body.messages) {
    if (!message || typeof message.content !== 'string') continue;
    if (message.content.length > MAX_MESSAGE_LENGTH) {
      return jsonResponse({ error: 'Message content too long.' }, 400, origin);
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    messages.push({ role, content: message.content });
  }
  if (messages.length === 0 || messages[0].role !== 'user') {
    return jsonResponse({ error: 'Conversation must start with a user message.' }, 400, origin);
  }

  try {
    const reply = await runClaudeConversation(env, messages);
    return jsonResponse({ reply }, 200, origin);
  } catch (error) {
    console.error('Chat handler failed', error);
    return jsonResponse(
      { error: 'The assistant is unavailable right now. Please try again shortly.' },
      502,
      origin
    );
  }
}

// ---------------------------------------------------------------------------
// /quote
// ---------------------------------------------------------------------------

async function handleQuote(request, env, origin) {
  if (!enforceRateLimit(request)) {
    return jsonResponse({ error: 'Rate limit exceeded. Please wait a moment.' }, 429, origin);
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    const tooLarge = /too large/i.test(error.message || '');
    return jsonResponse({ error: tooLarge ? 'Payload too large.' : 'Invalid request.' }, tooLarge ? 413 : 400, origin);
  }

  // Never trust a price sent from the client — the engine computes it here.
  const quote = computeQuote({
    pickup: body.pickup,
    destination: body.destination,
    vehicleClass: body.vehicleClass,
    passengers: body.passengers,
    returnTrip: body.returnTrip,
  });
  return jsonResponse(quote, 200, origin);
}

// ---------------------------------------------------------------------------
// /booking
// ---------------------------------------------------------------------------

function limitString(value) {
  if (typeof value !== 'string') return '';
  return value.slice(0, MAX_BOOKING_FIELD_LENGTH).trim();
}

function validateBooking(body) {
  if (typeof body !== 'object' || body === null) return 'Invalid booking payload.';
  const required = [
    'serviceType',
    'dateTime',
    'pickupLocation',
    'destination',
    'passengers',
    'name',
    'contact',
  ];
  for (const field of required) {
    const value = body[field];
    if (typeof value !== 'string' || !value.trim()) {
      return `Missing or invalid booking field: ${field}`;
    }
    if (value.length > MAX_BOOKING_FIELD_LENGTH) {
      return `Booking field too long: ${field}`;
    }
  }
  if (body.notes && String(body.notes).length > MAX_BOOKING_FIELD_LENGTH) {
    return 'Booking notes are too long.';
  }
  if (body.flightNumber && String(body.flightNumber).length > MAX_BOOKING_FIELD_LENGTH) {
    return 'Flight number is too long.';
  }
  return null;
}

function formatQuoteLine(quote) {
  if (!quote || typeof quote !== 'object') return 'Not quoted (callback requested).';
  if (quote.quotable === false) return `Not quoted: ${quote.reason || 'callback requested'}`;
  if (typeof quote.price === 'number') {
    return `£${quote.price} ${quote.currency || 'GBP'} (estimate, confirmed at booking)`;
  }
  return 'Not quoted.';
}

function formatBookingEmail(booking) {
  return [
    'New booking / quote request from the Executive Travel Wales website:',
    '',
    `Service type:   ${limitString(booking.serviceType)}`,
    `Date & time:    ${limitString(booking.dateTime)}`,
    `Pickup:         ${limitString(booking.pickupLocation)}`,
    `Destination:    ${limitString(booking.destination)}`,
    `Vehicle class:  ${limitString(booking.vehicleClass) || 'Not specified'}`,
    `Passengers:     ${limitString(booking.passengers)}`,
    `Return trip:    ${limitString(booking.returnTrip) || 'No'}`,
    `Flight number:  ${limitString(booking.flightNumber) || 'N/A'}`,
    `Name:           ${limitString(booking.name)}`,
    `Contact:        ${limitString(booking.contact)}`,
    `Notes:          ${limitString(booking.notes) || 'None'}`,
    `Quoted price:   ${formatQuoteLine(booking.quote)}`,
    '',
    'Please follow up with the customer to confirm.',
  ].join('\n');
}

// Email provider behind a single function so it can be swapped (Resend / MailChannels).
async function sendBookingEmail(env, booking) {
  const provider = (env.EMAIL_PROVIDER || 'resend').toLowerCase();
  const to = env.BOOKING_TO_EMAIL;
  const from = env.BOOKING_FROM_EMAIL;
  if (!to || !from) throw new Error('Missing BOOKING_TO_EMAIL / BOOKING_FROM_EMAIL.');

  const subject = 'New booking request from Executive Travel Wales';
  const text = formatBookingEmail(booking);

  if (provider === 'resend') {
    if (!env.RESEND_API_KEY) throw new Error('Missing RESEND_API_KEY.');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({ from, to: [to], reply_to: limitString(booking.contact) || undefined, subject, text }),
    });
    if (!response.ok) {
      throw new Error(`Resend failed: ${response.status} ${await response.text()}`);
    }
    return;
  }

  if (provider === 'mailchannels') {
    const response = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from, name: 'Executive Travel Wales' },
        subject,
        content: [{ type: 'text/plain', value: text }],
      }),
    });
    if (!response.ok) {
      throw new Error(`MailChannels failed: ${response.status} ${await response.text()}`);
    }
    return;
  }

  throw new Error(`Unsupported email provider: ${provider}`);
}

async function handleBooking(request, env, origin) {
  if (!enforceRateLimit(request)) {
    return jsonResponse({ error: 'Rate limit exceeded. Please wait a moment.' }, 429, origin);
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    const tooLarge = /too large/i.test(error.message || '');
    return jsonResponse({ error: tooLarge ? 'Payload too large.' : 'Invalid request.' }, tooLarge ? 413 : 400, origin);
  }

  const validationError = validateBooking(body);
  if (validationError) {
    return jsonResponse({ error: validationError }, 400, origin);
  }

  try {
    await sendBookingEmail(env, body);
    return jsonResponse({ ok: true }, 200, origin);
  } catch (error) {
    console.error('Booking email failed', error);
    return jsonResponse({ error: 'Could not submit your booking right now.' }, 500, origin);
  }
}

// ---------------------------------------------------------------------------
// Facebook Messenger.
//
// GET  /messenger — webhook verification (Meta sends hub.challenge).
// POST /messenger — incoming messages. Verified by HMAC signature, processed
//                   with the same Claude brain + quote engine + booking email.
// These are server-to-server (no Origin header), so they bypass the CORS gate
// and are secured by the verify token + app-secret signature instead.
// ---------------------------------------------------------------------------

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const FB_HISTORY_TURNS = 16; // user+assistant messages kept per Messenger user
const FB_HISTORY_TTL = 60 * 60 * 24; // 24h
const FB_MSG_LIMIT = 1900; // Messenger hard limit is 2000 chars

// Records what happened on the last Messenger event, for debugging (no message
// text stored). Read via GET /messenger/debug?token=<verify token>.
async function putMessengerDebug(env, record) {
  if (!env.CHAT_HISTORY) return;
  try {
    await env.CHAT_HISTORY.put('debug:messenger', JSON.stringify({ ...record, ts: Date.now() }), {
      expirationTtl: 3600,
    });
  } catch (e) {
    /* ignore */
  }
}

function handleMessengerVerify(request, env) {
  const params = new URL(request.url).searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');
  if (mode === 'subscribe' && token && token === env.MESSENGER_VERIFY_TOKEN) {
    return new Response(challenge || '', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response('Forbidden', { status: 403 });
}

async function verifyMessengerSignature(rawBody, header, appSecret) {
  if (!header || !appSecret || !header.startsWith('sha256=')) return false;
  const sigHex = header.slice('sha256='.length);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== sigHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sigHex.charCodeAt(i);
  return diff === 0;
}

// Resolve the Page Access Token to reply with. Supports multiple Facebook Pages
// via MESSENGER_PAGE_TOKENS (JSON: {"<pageId>":"<token>"}), with a single-page
// MESSENGER_PAGE_TOKEN fallback.
function pageTokenFor(env, pageId) {
  if (env.MESSENGER_PAGE_TOKENS) {
    try {
      const map = JSON.parse(env.MESSENGER_PAGE_TOKENS);
      if (map && typeof map === 'object') {
        if (pageId && map[pageId]) return map[pageId];
        const values = Object.values(map);
        if (values.length === 1) return values[0]; // only one page configured
      }
    } catch (e) {
      console.error('MESSENGER_PAGE_TOKENS is not valid JSON');
    }
  }
  return env.MESSENGER_PAGE_TOKEN || null;
}

async function sendMessengerMessage(env, pageId, recipientId, text) {
  const token = pageTokenFor(env, pageId);
  if (!token) {
    console.error('No page token configured for page', pageId);
    return { ok: false, error: 'no_token_for_page' };
  }
  // Split long replies under the Messenger character limit, on line breaks.
  const chunks = [];
  let remaining = String(text || '').trim() || 'Sorry, please try again.';
  while (remaining.length > FB_MSG_LIMIT) {
    let cut = remaining.lastIndexOf('\n', FB_MSG_LIMIT);
    if (cut < FB_MSG_LIMIT / 2) cut = FB_MSG_LIMIT;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trim();
  }
  chunks.push(remaining);
  for (const chunk of chunks) {
    const res = await fetch(`${GRAPH_API}/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text: chunk } }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('Messenger send failed', res.status, body);
      return { ok: false, status: res.status, error: body.slice(0, 300) };
    }
  }
  return { ok: true };
}

async function loadFbHistory(env, pageId, psid) {
  if (!env.CHAT_HISTORY) return [];
  try {
    const raw = await env.CHAT_HISTORY.get(`fb:${pageId}:${psid}`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

async function saveFbHistory(env, pageId, psid, history) {
  if (!env.CHAT_HISTORY) return;
  try {
    await env.CHAT_HISTORY.put(`fb:${pageId}:${psid}`, JSON.stringify(history.slice(-FB_HISTORY_TURNS)), {
      expirationTtl: FB_HISTORY_TTL,
    });
  } catch (e) {
    console.error('KV save failed', e);
  }
}

async function processMessengerEvent(env, pageId, psid, userText) {
  const text = String(userText).slice(0, MAX_MESSAGE_LENGTH);
  const history = await loadFbHistory(env, pageId, psid);
  // Persist only plain text turns; tool rounds stay inside runClaudeConversation.
  const working = history.map((m) => ({ role: m.role, content: m.content }));
  working.push({ role: 'user', content: text });

  let reply;
  try {
    reply = await runClaudeConversation(env, working);
  } catch (e) {
    console.error('Messenger Claude failed', e);
    reply = `Sorry, I'm having trouble right now. Please call us on ${env.BUSINESS_PHONE || ''}.`.trim();
  }

  const { clean, booking } = extractBooking(reply);
  const outText = clean || reply;
  if (booking) {
    try {
      await sendBookingEmail(env, booking);
    } catch (e) {
      console.error('Messenger booking email failed', e);
    }
  }
  const sendResult = await sendMessengerMessage(env, pageId, psid, outText);
  await putMessengerDebug(env, {
    stage: 'processed',
    pageId,
    hasTokenForPage: !!pageTokenFor(env, pageId),
    send: sendResult,
    replyChars: outText.length,
    booking: !!booking,
  });

  const updated = history.concat([
    { role: 'user', content: text },
    { role: 'assistant', content: outText },
  ]);
  await saveFbHistory(env, pageId, psid, updated);
}

async function handleMessengerWebhook(request, env, ctx) {
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return new Response('Too large', { status: 413 });

  const sigHeader = request.headers.get('x-hub-signature-256');
  const ok = await verifyMessengerSignature(rawBody, sigHeader, env.MESSENGER_APP_SECRET);
  if (!ok) {
    await putMessengerDebug(env, {
      stage: 'signature_failed',
      hasSignatureHeader: !!sigHeader,
      hasAppSecret: !!env.MESSENGER_APP_SECRET,
    });
    return new Response('Invalid signature', { status: 403 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return new Response('Bad JSON', { status: 400 });
  }
  if (payload.object !== 'page') {
    await putMessengerDebug(env, { stage: 'not_page_object', object: payload.object });
    return new Response('Not a page event', { status: 404 });
  }
  await putMessengerDebug(env, { stage: 'received', entries: (payload.entry || []).length });

  const jobs = [];
  for (const entry of payload.entry || []) {
    const pageId = entry.id; // the Facebook Page this event is for
    for (const event of entry.messaging || []) {
      const psid = event.sender && event.sender.id;
      const message = event.message;
      if (psid && message && message.text && !message.is_echo) {
        jobs.push(processMessengerEvent(env, pageId, psid, message.text));
      }
    }
  }
  // Acknowledge immediately; keep processing after responding (Meta needs a fast 200).
  ctx.waitUntil(Promise.all(jobs));
  return new Response('EVENT_RECEIVED', { status: 200 });
}

// ---------------------------------------------------------------------------
// Router.
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Protected debug breadcrumb for Messenger troubleshooting.
    if (url.pathname === '/messenger/debug' && request.method === 'GET') {
      if (url.searchParams.get('token') !== env.MESSENGER_VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      const value = env.CHAT_HISTORY ? await env.CHAT_HISTORY.get('debug:messenger') : null;
      return new Response(value || '{"info":"no messenger events recorded yet"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Messenger webhook is server-to-server (no Origin) — handle before CORS gate.
    if (url.pathname === '/messenger') {
      if (request.method === 'GET') return handleMessengerVerify(request, env);
      if (request.method === 'POST') return handleMessengerWebhook(request, env, ctx);
      return new Response('Method not allowed', { status: 405 });
    }

    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      if (!isOriginAllowed(origin, env)) {
        return textResponse('CORS origin denied.', 403, origin);
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!isOriginAllowed(origin, env)) {
      return textResponse('CORS origin denied.', 403, origin);
    }

    if (request.method === 'POST' && url.pathname === '/chat') {
      return handleChat(request, env, origin);
    }
    if (request.method === 'POST' && url.pathname === '/quote') {
      return handleQuote(request, env, origin);
    }
    if (request.method === 'POST' && url.pathname === '/booking') {
      return handleBooking(request, env, origin);
    }

    return jsonResponse({ error: 'Not found' }, 404, origin);
  },
};
