/* Executive Travel Wales — embeddable chat widget.
 *
 * Self-contained: injects its own styles + markup, no build step, no deps.
 * Embed with:
 *   <script src="https://YOURDOMAIN/widget.js"
 *           data-worker-url="https://YOUR-WORKER-URL"
 *           data-accent="#c9a24b"
 *           data-greeting="Hi! Need a quote or have a question?"></script>
 *
 * Modes:
 *   - Live: posts the conversation to the Worker's /chat endpoint. Claude drives
 *     the conversation (and calls the server-side quote engine). When the visitor
 *     confirms a booking, Claude emits a [[BOOKING]]{...}[[/BOOKING]] block which
 *     this widget strips from the displayed text and POSTs to /booking.
 *   - Demo (data-demo="true", or no worker URL): a scripted offline flow with a
 *     local copy of the fixed-route pricing so the look + quote/booking flow can
 *     be approved without a backend.
 */
(function () {
  'use strict';

  var SCRIPT_SELECTOR = 'script[src*="widget.js"]';
  var STORAGE_KEY = 'etw-chat-session-v2';
  // Used in the widget's own demo/error/fallback messages (live chat replies come
  // from the Worker, which has the phone number in its system prompt).
  var PHONE_PLACEHOLDER = '07312000444';

  var DEFAULTS = {
    accentColor: '#c9a24b',
    greeting: 'Hi! Need a quote or have a question?',
    businessName: 'Executive Travel Wales',
    workerUrl: '',
    demo: false,
  };

  // ---- Local pricing mirror (demo mode only; live mode uses the Worker) ----
  var PICKUP_POINT = 'Merthyr Tydfil';
  var FIXED_ROUTES = {
    Bristol: { car: 260, '8_seater': 300, '16_seater': 440, '24_seater': 700, '28_seater': 650 },
    Cardiff: { car: 180, '8_seater': 220, '16_seater': 340, '24_seater': 450, '28_seater': 400 },
    Birmingham: { car: 400, '8_seater': 450, '16_seater': 650, '24_seater': 850, '28_seater': 750 },
    Heathrow: { car: 500, '8_seater': 600, '16_seater': 800, '24_seater': 1000, '28_seater': 1200 },
    Gatwick: { car: 600, '8_seater': 750, '16_seater': 900, '24_seater': 1200, '28_seater': 1400 },
  };
  var VEHICLE_LABELS = {
    car: 'Executive car',
    '8_seater': '8-seater',
    '16_seater': '16-seater minibus',
    '24_seater': '24-seater coach',
    '28_seater': '28-seater coach',
  };

  function normalise(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function matchDestination(text) {
    var n = normalise(text);
    if (/lhr|heathrow/.test(n)) return 'Heathrow';
    if (/lgw|gatwick/.test(n)) return 'Gatwick';
    if (/bristol|brs/.test(n)) return 'Bristol';
    if (/cardiff|cwl/.test(n)) return 'Cardiff';
    if (/birmingham|bhx/.test(n)) return 'Birmingham';
    return null;
  }
  function matchVehicleClass(text) {
    var n = normalise(text);
    if (/28/.test(n)) return '28_seater';
    if (/24/.test(n)) return '24_seater';
    if (/16|minibus/.test(n)) return '16_seater';
    if (/8|eight/.test(n)) return '8_seater';
    if (/car|saloon|exec|sedan/.test(n)) return 'car';
    return null;
  }
  function isReturn(text) {
    var n = normalise(text);
    if (/^(no|n|one way|single)/.test(n)) return false;
    return /(yes|y|return|round|both)/.test(n);
  }
  // One-way = half the return fare, plus 10%.
  var ONE_WAY_FACTOR = 0.55;
  function localQuote(booking) {
    if (!/merthyr/.test(normalise(booking.pickupLocation))) {
      return { quotable: false, reason: 'Listed prices are for journeys starting in Merthyr Tydfil only. The team will send a personalised quote.' };
    }
    var dest = matchDestination(booking.destination);
    if (!dest) {
      return { quotable: false, reason: 'That destination is not on our fixed-route list (Bristol, Cardiff, Birmingham, Heathrow, Gatwick). The team will send a personalised quote.' };
    }
    var vc = booking.vehicleClass;
    if (!FIXED_ROUTES[dest][vc]) {
      return { quotable: false, reason: 'Please choose a vehicle class so we can price it.' };
    }
    var returnFare = FIXED_ROUTES[dest][vc];
    var ret = isReturn(booking.returnTrip);
    var price = ret ? returnFare : Math.round(returnFare * ONE_WAY_FACTOR);
    return {
      quotable: true, price: price, currency: 'GBP', estimate: true,
      destination: dest + ' Airport', vehicleLabel: VEHICLE_LABELS[vc], returnTrip: ret, returnFare: returnFare,
    };
  }
  function formatQuoteMessage(quote) {
    if (!quote.quotable) {
      return quote.reason + ' You can reach us on ' + PHONE_PLACEHOLDER + '.';
    }
    var lines = [
      'Estimate, confirmed at booking',
      '',
      quote.vehicleLabel + ': ' + PICKUP_POINT + ' to ' + quote.destination + (quote.returnTrip ? ' (return)' : ' (one-way)'),
      (quote.returnTrip ? 'Return fare: £' : 'One-way fare: £') + quote.price,
      '',
      'Total estimate: £' + quote.price,
      '',
      'Please note: prices are from one pickup point in Merthyr Tydfil, and this is an estimate confirmed at booking.',
    ];
    return lines.join('\n');
  }

  // ---- Config ----
  function getConfig() {
    var script = document.querySelector(SCRIPT_SELECTOR);
    var cfg = {};
    for (var k in DEFAULTS) cfg[k] = DEFAULTS[k];
    if (script) {
      if (script.dataset.workerUrl) cfg.workerUrl = script.dataset.workerUrl.replace(/\/+$/, '');
      if (script.dataset.accent) cfg.accentColor = script.dataset.accent;
      if (script.dataset.greeting) cfg.greeting = script.dataset.greeting;
      if (script.dataset.businessName) cfg.businessName = script.dataset.businessName;
      if (script.dataset.demo !== undefined) cfg.demo = script.dataset.demo === 'true' || script.dataset.demo === '1';
    }
    if (!cfg.workerUrl) cfg.demo = true; // no backend → demo
    return cfg;
  }

  // ---- DOM helpers ----
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    for (var key in attrs) {
      if (key === 'className') node.className = attrs[key];
      else if (key === 'text') node.textContent = attrs[key];
      else if (key === 'html') node.innerHTML = attrs[key];
      else node.setAttribute(key, attrs[key]);
    }
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }

  function applyStyles(accent) {
    if (document.getElementById('etw-widget-styles')) return;
    var style = document.createElement('style');
    style.id = 'etw-widget-styles';
    style.textContent = [
      '.etw-root{--etw-accent:' + accent + ';--etw-bg:#13161c;--etw-surface:#1b1f29;--etw-surface-2:#232834;',
      '--etw-text:#eef1f6;--etw-muted:#9aa3b2;--etw-border:rgba(255,255,255,.08);',
      'position:fixed;bottom:24px;right:24px;z-index:2147483000;',
      'font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}',
      '.etw-launch{display:flex;align-items:center;gap:10px;flex-direction:row-reverse;}',
      '.etw-bubble{background:var(--etw-surface);color:var(--etw-text);border:1px solid var(--etw-border);',
      'border-radius:14px;padding:9px 13px;font-size:13px;max-width:220px;box-shadow:0 12px 30px rgba(0,0,0,.25);}',
      '.etw-btn{border:none;cursor:pointer;background:var(--etw-accent);color:#1a1408;width:58px;height:58px;',
      'border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 14px 34px rgba(0,0,0,.35);',
      'transition:transform .18s ease;}',
      '.etw-btn:hover{transform:translateY(-2px);}',
      '.etw-btn svg{width:26px;height:26px;}',
      '.etw-panel{display:flex;flex-direction:column;width:min(380px,calc(100vw - 32px));height:min(620px,calc(100vh - 48px));',
      'background:var(--etw-surface);border:1px solid var(--etw-border);border-radius:18px;overflow:hidden;',
      'box-shadow:0 30px 80px rgba(0,0,0,.5);}',
      '.etw-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;',
      'background:linear-gradient(180deg,rgba(255,255,255,.05),transparent);border-bottom:1px solid var(--etw-border);}',
      '.etw-head h2{margin:0;font-size:15px;font-weight:600;color:#fff;letter-spacing:.01em;}',
      '.etw-head .etw-sub{display:block;font-size:11px;color:var(--etw-muted);font-weight:400;margin-top:2px;}',
      '.etw-x{border:none;background:transparent;color:var(--etw-muted);font-size:22px;line-height:1;cursor:pointer;padding:0 4px;}',
      '.etw-x:hover{color:#fff;}',
      '.etw-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;}',
      '.etw-msg{max-width:88%;padding:11px 14px;border-radius:16px;font-size:14px;line-height:1.55;word-wrap:break-word;white-space:normal;}',
      '.etw-msg.user{align-self:flex-end;background:var(--etw-accent);color:#1a1408;border-bottom-right-radius:5px;}',
      '.etw-msg.assistant{align-self:flex-start;background:var(--etw-surface-2);color:var(--etw-text);border-bottom-left-radius:5px;}',
      '.etw-msg.notice{align-self:center;background:transparent;color:var(--etw-muted);font-size:12px;text-align:center;padding:2px 8px;}',
      '.etw-typing{align-self:flex-start;display:flex;gap:5px;padding:13px 14px;background:var(--etw-surface-2);border-radius:16px;}',
      '.etw-dot{width:7px;height:7px;border-radius:50%;background:var(--etw-muted);animation:etw-pulse 1.2s infinite ease-in-out;}',
      '.etw-dot:nth-child(2){animation-delay:.15s;}.etw-dot:nth-child(3){animation-delay:.3s;}',
      '@keyframes etw-pulse{0%,100%{opacity:.4;transform:scale(.8);}50%{opacity:1;transform:scale(1);}}',
      '.etw-input{display:flex;gap:8px;padding:12px;border-top:1px solid var(--etw-border);background:var(--etw-surface-2);}',
      '.etw-input textarea{flex:1;resize:none;border:1px solid var(--etw-border);background:rgba(255,255,255,.04);',
      'color:var(--etw-text);border-radius:12px;padding:10px 12px;font:inherit;font-size:14px;max-height:120px;}',
      '.etw-input textarea:focus{outline:none;border-color:var(--etw-accent);}',
      '.etw-send{border:none;background:var(--etw-accent);color:#1a1408;border-radius:12px;padding:0 16px;font-weight:600;cursor:pointer;}',
      '.etw-send:disabled{opacity:.5;cursor:default;}',
      '.etw-foot{text-align:center;font-size:11px;color:var(--etw-muted);padding:8px;}',
      '.etw-hidden{display:none !important;}',
      '@media (max-width:520px){.etw-root{bottom:12px;right:12px;left:12px;}',
      '.etw-panel{width:100%;height:calc(100vh - 24px);}.etw-bubble{max-width:none;}}',
      '@media (prefers-reduced-motion:reduce){.etw-btn,.etw-dot{transition:none;animation:none;}}',
    ].join('');
    document.head.appendChild(style);
  }

  // ---- Chat icon ----
  var CHAT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z"/></svg>';

  // ---- State ----
  function freshBooking() {
    return {
      active: false, step: null, awaitingConfirm: false, awaitingFlight: false, quote: null,
      serviceType: '', dateTime: '', pickupLocation: '', destination: '',
      vehicleClass: '', passengers: '', returnTrip: '', flightNumber: '', name: '', contact: '', notes: '',
    };
  }

  function buildUI(config, state) {
    var root = el('div', { className: 'etw-root' });

    // Launcher
    var launch = el('div', { className: 'etw-launch' });
    var bubble = el('div', { className: 'etw-bubble', text: config.greeting });
    var btn = el('button', { className: 'etw-btn', type: 'button', 'aria-label': 'Open chat', html: CHAT_ICON });
    launch.appendChild(btn);
    launch.appendChild(bubble);

    // Panel
    var panel = el('div', { className: 'etw-panel etw-hidden', role: 'dialog', 'aria-label': config.businessName + ' chat' });
    var titleWrap = el('div', {}, [
      el('h2', { text: config.businessName }),
      el('span', { className: 'etw-sub', text: 'Quotes & bookings assistant' }),
    ]);
    var closeBtn = el('button', { className: 'etw-x', type: 'button', 'aria-label': 'Close chat', html: '&times;' });
    var head = el('div', { className: 'etw-head' }, [titleWrap, closeBtn]);

    var msgs = el('div', { className: 'etw-msgs', role: 'log', 'aria-live': 'polite' });

    var textarea = el('textarea', { rows: '1', placeholder: 'Type a message…', 'aria-label': 'Message' });
    var send = el('button', { className: 'etw-send', type: 'button', text: 'Send' });
    var inputRow = el('div', { className: 'etw-input' }, [textarea, send]);
    var foot = el('div', { className: 'etw-foot', text: 'Powered by ' + config.businessName });

    panel.appendChild(head);
    panel.appendChild(msgs);
    panel.appendChild(inputRow);
    panel.appendChild(foot);

    root.appendChild(panel);
    root.appendChild(launch);
    document.body.appendChild(root);

    return { root: root, launch: launch, bubble: bubble, btn: btn, panel: panel, closeBtn: closeBtn, msgs: msgs, textarea: textarea, send: send };
  }

  function scrollToEnd(ui) {
    requestAnimationFrame(function () { ui.msgs.scrollTop = ui.msgs.scrollHeight; });
  }

  function renderMessage(ui, msg) {
    var node = el('div', { className: 'etw-msg ' + msg.role, html: escapeHtml(msg.text) });
    ui.msgs.appendChild(node);
    scrollToEnd(ui);
  }

  function showTyping(ui) {
    var node = el('div', { className: 'etw-typing', 'data-typing': '1' }, [
      el('span', { className: 'etw-dot' }), el('span', { className: 'etw-dot' }), el('span', { className: 'etw-dot' }),
    ]);
    ui.msgs.appendChild(node);
    scrollToEnd(ui);
  }
  function hideTyping(ui) {
    var t = ui.msgs.querySelector('[data-typing="1"]');
    if (t) t.remove();
  }

  // ---- Persistence ----
  function saveSession(state) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ messages: state.messages, booking: state.booking, open: state.open }));
    } catch (e) { /* ignore quota / disabled storage */ }
  }
  function loadSession() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  // ---- Message plumbing ----
  function pushMessage(app, role, text) {
    var msg = { role: role, text: text };
    app.state.messages.push(msg);
    renderMessage(app.ui, msg);
    saveSession(app.state);
  }
  function pushNotice(app, text) { pushMessage(app, 'notice', text); }

  // ====================================================================
  // Demo (offline) scripted flow
  // ====================================================================
  var DEMO_STEPS = [
    { key: 'serviceType', q: 'What type of service do you need? (airport transfer, corporate, wedding, event or other)' },
    { key: 'dateTime', q: 'What date and time would you like?' },
    { key: 'pickupLocation', q: 'Where should we pick you up from? (note: our listed prices are from a single pickup point in Merthyr Tydfil)' },
    { key: 'destination', q: 'Which airport are you heading to? (Bristol, Cardiff, Birmingham, Heathrow or Gatwick)' },
    { key: 'vehicleClass', q: 'Which vehicle would you like? Executive car (up to 3), 8-seater, 16-seater minibus, 24-seater coach or 28-seater coach.' },
    { key: 'passengers', q: 'How many passengers? Please mention any luggage or child seats too.' },
    { key: 'returnTrip', q: 'Is this a return trip? (yes/no)' },
  ];
  var CONTACT_STEPS = [
    { key: 'name', q: 'Lovely. May I take your name?' },
    { key: 'contact', q: 'And the best email address or phone number to reach you on?' },
    { key: 'notes', q: 'Any extra notes for the team? (or say "none")' },
  ];

  function validateContact(text) {
    var email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
    var phone = /\+?\d[\d ()+-]{7,}\d/;
    if (email.test(text)) return text.match(email)[0];
    if (phone.test(text)) return text.trim();
    return null;
  }

  var BOOKING_TRIGGER = /\b(quote|book|booking|price|cost|how much|airport|transfer|wedding|corporate|event|minibus|coach|taxi|hire|pickup|pick up|lift)\b/i;

  function startDemoBooking(app) {
    app.state.booking = freshBooking();
    app.state.booking.active = true;
    app.state.booking.step = 0;
    pushNotice(app, 'Let’s get you a quote. A few quick questions.');
    pushMessage(app, 'assistant', DEMO_STEPS[0].q);
  }

  function demoConfirmSummary(app) {
    var b = app.state.booking;
    var lines = [
      'Here’s your request. Please confirm (yes/no):', '',
      'Service: ' + b.serviceType,
      'Date & time: ' + b.dateTime,
      'Pickup: ' + b.pickupLocation,
      'Destination: ' + b.destination,
      'Vehicle: ' + (VEHICLE_LABELS[b.vehicleClass] || b.vehicleClass),
      'Passengers: ' + b.passengers,
      'Return: ' + b.returnTrip,
    ];
    if (b.flightNumber) lines.push('Flight no: ' + b.flightNumber);
    lines.push('Name: ' + b.name);
    lines.push('Contact: ' + b.contact);
    lines.push('Notes: ' + (b.notes || 'None'));
    if (b.quote && b.quote.quotable) lines.push('Estimate: £' + b.quote.price + ' (confirmed at booking)');
    pushMessage(app, 'assistant', lines.join('\n'));
  }

  // Show the quote, then move into collecting contact details (demo flow).
  function demoQuoteThenContact(app, b) {
    b.quote = localQuote(b);
    pushMessage(app, 'assistant', formatQuoteMessage(b.quote));
    pushMessage(app, 'assistant', (b.quote.quotable
      ? 'Shall I take your details to book this? '
      : 'I can still take your details for a personalised callback. ') + CONTACT_STEPS[0].q);
    b.step = DEMO_STEPS.length;
    b.contactStep = 0;
  }

  function handleDemoBooking(app, text) {
    var b = app.state.booking;

    if (b.awaitingConfirm) {
      if (/\b(yes|y|confirm|correct|go ahead|send|please do)\b/i.test(text)) {
        b.active = false; b.awaitingConfirm = false;
        pushMessage(app, 'assistant', 'Thank you, that’s all we need. The team will be in touch shortly to confirm. For anything urgent, call ' + PHONE_PLACEHOLDER + '.');
        pushNotice(app, 'Demo mode: no booking email was sent.');
        saveSession(app.state);
        return;
      }
      if (/\b(no|n|change|edit|wrong)\b/i.test(text)) {
        b.awaitingConfirm = false; b.active = true; b.step = 0;
        pushMessage(app, 'assistant', 'No problem, let’s go through it again. ' + DEMO_STEPS[0].q);
        return;
      }
      pushMessage(app, 'assistant', 'Please reply "yes" to confirm or "no" to change something.');
      return;
    }

    // Return-trip flight number (asked once the visitor says it's a return).
    if (b.awaitingFlight) {
      b.flightNumber = text.trim();
      b.awaitingFlight = false;
      demoQuoteThenContact(app, b);
      return;
    }

    // Trip-detail steps
    if (b.step < DEMO_STEPS.length) {
      var step = DEMO_STEPS[b.step];
      if (step.key === 'vehicleClass') {
        var vc = matchVehicleClass(text);
        if (!vc) { pushMessage(app, 'assistant', 'Please pick one: Executive car, 8-seater, 16-seater minibus, 24-seater coach or 28-seater coach.'); return; }
        b.vehicleClass = vc;
      } else {
        b[step.key] = text.trim();
      }
      b.step++;

      if (b.step === DEMO_STEPS.length) {
        // For a return trip, get the flight number before quoting.
        if (isReturn(b.returnTrip) && !b.flightNumber) {
          b.awaitingFlight = true;
          pushMessage(app, 'assistant', 'As it’s a return trip, what’s your return flight number? This lets us track your inbound flight for the pickup.');
          return;
        }
        demoQuoteThenContact(app, b);
        return;
      }
      pushMessage(app, 'assistant', DEMO_STEPS[b.step].q);
      return;
    }

    // Contact steps
    var cs = CONTACT_STEPS[b.contactStep];
    if (cs.key === 'contact') {
      var v = validateContact(text);
      if (!v) { pushMessage(app, 'assistant', 'Please share a valid email address or phone number.'); return; }
      b.contact = v;
    } else if (cs.key === 'notes') {
      b.notes = /\b(no|none|n\/a|nope)\b/i.test(text) ? '' : text.trim();
    } else {
      b[cs.key] = text.trim();
    }
    b.contactStep++;

    if (b.contactStep < CONTACT_STEPS.length) {
      pushMessage(app, 'assistant', CONTACT_STEPS[b.contactStep].q);
      return;
    }
    b.awaitingConfirm = true;
    demoConfirmSummary(app);
  }

  function demoReply(app, text) {
    if (app.state.booking.active) { handleDemoBooking(app, text); return; }
    if (BOOKING_TRIGGER.test(text)) { startDemoBooking(app); return; }

    var n = normalise(text);
    var reply;
    if (/airport/.test(n)) reply = 'We run airport transfers from Merthyr Tydfil to Bristol, Cardiff, Birmingham, Heathrow and Gatwick. Ask for a quote and I’ll price it for you.';
    else if (/wedding/.test(n)) reply = 'For weddings we provide smart vehicles and professional chauffeurs. I can take some details for a bespoke quote.';
    else if (/hour|open|time/.test(n)) reply = 'We operate 24/7. How can I help with your travel?';
    else if (/contact|phone|email|call/.test(n)) reply = 'You can reach the team on ' + PHONE_PLACEHOLDER + '. Would you like a quote in the meantime?';
    else reply = 'I can answer questions about Executive Travel Wales or get you a quote for an airport transfer. Would you like a quote?';
    pushMessage(app, 'assistant', reply);
  }

  // ====================================================================
  // Live flow (Worker-backed, Claude-driven)
  // ====================================================================
  var BOOKING_BLOCK = /\[\[BOOKING\]\]([\s\S]*?)\[\[\/BOOKING\]\]/;

  function parseBookingBlock(text) {
    var match = text.match(BOOKING_BLOCK);
    if (!match) return { clean: text, booking: null };
    var clean = text.replace(BOOKING_BLOCK, '').trim();
    var booking = null;
    try { booking = JSON.parse(match[1].trim()); } catch (e) { booking = null; }
    return { clean: clean, booking: booking };
  }

  function liveHistory(state) {
    var history = state.messages
      .filter(function (m) { return m.role === 'user' || m.role === 'assistant'; })
      .map(function (m) { return { role: m.role, content: m.text }; });
    // The Claude API requires the conversation to start with a user message, so
    // drop the widget's opening assistant greeting (and any leading assistant turns).
    while (history.length && history[0].role === 'assistant') history.shift();
    return history;
  }

  function submitBooking(app, booking) {
    fetch(app.config.workerUrl + '/booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(booking),
    }).then(function (res) {
      if (!res.ok) { pushNotice(app, 'We couldn’t email your request automatically. Please call ' + PHONE_PLACEHOLDER + '.'); }
      else { pushNotice(app, 'Your request has been sent to the team.'); }
    }).catch(function () {
      pushNotice(app, 'We couldn’t email your request automatically. Please call ' + PHONE_PLACEHOLDER + '.');
    });
  }

  function liveReply(app, text) {
    setBusy(app, true);
    showTyping(app.ui);
    fetch(app.config.workerUrl + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: liveHistory(app.state) }),
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (result) {
        hideTyping(app.ui);
        if (!result.ok) {
          pushMessage(app, 'assistant', (result.data && result.data.error) || 'Sorry, something went wrong. Please call ' + PHONE_PLACEHOLDER + '.');
          return;
        }
        var replyText = (result.data && result.data.reply) || '';
        var parsed = parseBookingBlock(replyText);
        pushMessage(app, 'assistant', parsed.clean || 'Sorry, I didn’t catch that. Could you rephrase?');
        if (parsed.booking) submitBooking(app, parsed.booking);
      })
      .catch(function () {
        hideTyping(app.ui);
        pushMessage(app, 'assistant', 'Sorry, the chat service is unavailable right now. Please call ' + PHONE_PLACEHOLDER + '.');
      })
      .then(function () { setBusy(app, false); });
  }

  function setBusy(app, busy) {
    app.state.busy = busy;
    app.ui.send.disabled = busy;
    app.ui.textarea.disabled = busy;
  }

  // ====================================================================
  // Send dispatch
  // ====================================================================
  function sendCurrent(app) {
    if (app.state.busy) return;
    var text = app.ui.textarea.value.trim();
    if (!text) return;
    app.ui.textarea.value = '';
    app.ui.textarea.style.height = 'auto';
    pushMessage(app, 'user', text);
    if (app.config.demo) demoReply(app, text);
    else liveReply(app, text);
  }

  function openPanel(app, open) {
    app.state.open = open;
    app.ui.panel.classList.toggle('etw-hidden', !open);
    app.ui.launch.classList.toggle('etw-hidden', open);
    saveSession(app.state);
    if (open) app.ui.textarea.focus();
  }

  // ====================================================================
  // Init
  // ====================================================================
  function init() {
    var config = getConfig();
    applyStyles(config.accentColor);

    var saved = loadSession();
    var state = {
      messages: (saved && saved.messages) || [],
      booking: (saved && saved.booking) || freshBooking(),
      open: (saved && saved.open) || false,
      busy: false,
    };

    var ui = buildUI(config, state);
    var app = { config: config, state: state, ui: ui };

    // Greeting / restore.
    if (state.messages.length === 0) {
      pushMessage(app, 'assistant', config.greeting + ' I can answer questions or get you a quote for an airport transfer.');
    } else {
      state.messages.forEach(function (m) { renderMessage(ui, m); });
    }

    if (state.open) openPanel(app, true);

    ui.btn.addEventListener('click', function () { openPanel(app, !state.open); });
    ui.bubble.addEventListener('click', function () { openPanel(app, true); });
    ui.closeBtn.addEventListener('click', function () { openPanel(app, false); });
    ui.send.addEventListener('click', function () { sendCurrent(app); });
    ui.textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(app); }
    });
    ui.textarea.addEventListener('input', function () {
      ui.textarea.style.height = 'auto';
      ui.textarea.style.height = Math.min(ui.textarea.scrollHeight, 120) + 'px';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
