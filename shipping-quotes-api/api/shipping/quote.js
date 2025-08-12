// shipping-quotes-api/api/shipping/quote.js

module.exports = async (req, res) => {
  // --- CORS (keep '*' while testing; restrict to your domain later) ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const qs = req.query || {};
  const isDemo = String(qs.demo || '') === '1';
  const isDiag = String(qs.diag || '') === '1';

  // ---- QUICK BROWSER TESTS ----
  if (req.method === 'GET') {
    if (isDiag) return res.status(200).json(await diag());
    if (isDemo) return res.status(200).json(demoResponse());
    return res
      .status(200)
      .json({ ok: true, hint: 'Use ?demo=1 for demo quotes or ?diag=1 for diagnostics.' });
  }

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // Demo short-circuit (still available on POST)
  if (isDemo) return res.status(200).json(demoResponse());

  const body =
    typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const only = (qs.only || '').toString().toLowerCase(); // "ups" or "fedex"

  try {
    const tasks = [];
    const labels = [];
    if (!only || only === 'ups') {
      tasks.push(getUpsRates(body));
      labels.push('UPS');
    }
    if (!only || only === 'fedex') {
      tasks.push(getFedexRates(body));
      labels.push('FedEx');
    }

    const settled = await Promise.allSettled(tasks);

    const quotes = [];
    const errors = [];
    settled.forEach((r, i) => {
      const name = labels[i];
      if (r.status === 'fulfilled') quotes.push(...(r.value || []));
      else errors.push(`${name}: ${r.reason?.message || r.reason || 'unknown error'}`);
    });

    if (!quotes.length) {
      return res
        .status(502)
        .json({ error: 'No rates from carriers', detail: errors.join(' | ') || 'No quotes' });
    }

    quotes.sort((a, b) => a.total_charge - b.total_charge); // cheapest first
    res.status(200).json({ quotes, warnings: errors.length ? errors : undefined });
  } catch (e) {
    res.status(500).json({ error: 'Server failure', detail: e?.message || String(e) });
  }
};

// ---------------- helpers ----------------
function demoResponse() {
  return {
    quotes: [
      { carrier: 'UPS',   service_name: 'UPS® Ground',      total_charge: 38.45, transit_days: 4, estimated_delivery_date: null, notes: 'demo' },
      { carrier: 'FedEx', service_name: 'FedEx Ground®',    total_charge: 36.90, transit_days: 4, estimated_delivery_date: null, notes: 'demo' },
      { carrier: 'UPS',   service_name: 'UPS 2nd Day Air®', total_charge: 94.20, transit_days: 2, estimated_delivery_date: null, notes: 'demo' },
      { carrier: 'FedEx', service_name: 'FedEx 2Day®',      total_charge: 92.10, transit_days: 2, estimated_delivery_date: null, notes: 'demo' }
    ]
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// Diagnostics: check env vars and just the OAuth steps
async function diag() {
  const out = {
    env: {
      UPS_CLIENT_ID: !!process.env.UPS_CLIENT_ID,
      UPS_CLIENT_SECRET: !!process.env.UPS_CLIENT_SECRET,
      FEDEX_CLIENT_ID: !!process.env.FEDEX_CLIENT_ID,
      FEDEX_CLIENT_SECRET: !!process.env.FEDEX_CLIENT_SECRET,
      FEDEX_ACCOUNT_NUMBER: !!process.env.FEDEX_ACCOUNT_NUMBER,
      UPS_ACCOUNT_NUMBER: !!process.env.UPS_ACCOUNT_NUMBER
    },
    reach: {},
    upsAuth_www: null,
    upsAuth_wwwcie: null,
    fedexAuth_basic: null,
    fedexAuth_body: null
  };

  // Simple reachability test
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    out.reach.ipify = { ok: r.ok, status: r.status };
  } catch (e) {
    out.reach.ipify = { ok: false, error: String(e.message || e) };
  }

  // UPS OAuth on production host
  try {
    const auth = Buffer.from(`${process.env.UPS_CLIENT_ID}:${process.env.UPS_CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://www.ups.com/security/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
      body: 'grant_type=client_credentials'
    });
    out.upsAuth_www = { ok: r.ok, status: r.status, text: r.ok ? 'OK' : await r.text().catch(()=> 'text err') };
  } catch (e) {
    out.upsAuth_www = { ok: false, error: String(e.message || e) };
  }

  // UPS OAuth on sandbox host (helps determine if prod host is the issue)
  try {
    const auth = Buffer.from(`${process.env.UPS_CLIENT_ID}:${process.env.UPS_CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://wwwcie.ups.com/security/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
      body: 'grant_type=client_credentials'
    });
    out.upsAuth_wwwcie = { ok: r.ok, status: r.status, text: r.ok ? 'OK' : await r.text().catch(()=> 'text err') };
  } catch (e) {
    out.upsAuth_wwwcie = { ok: false, error: String(e.message || e) };
  }

  // FedEx OAuth using Basic auth header
  try {
    const auth = Buffer.from(`${process.env.FEDEX_CLIENT_ID}:${process.env.FEDEX_CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://apis.fedex.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
      body: 'grant_type=client_credentials'
    });
    out.fedexAuth_basic = { ok: r.ok, status: r.status, text: r.ok ? 'OK' : await r.text().catch(()=> 'text err') };
  } catch (e) {
    out.fedexAuth_basic = { ok: false, error: String(e.message || e) };
  }

  // FedEx OAuth with client_id/secret in body
  try {
    const params = new URLSearchParams();
    params.set('grant_type', 'client_credentials');
    params.set('client_id', process.env.FEDEX_CLIENT_ID || '');
    params.set('client_secret', process.env.FEDEX_CLIENT_SECRET || '');
    const r = await fetch('https://apis.fedex.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    out.fedexAuth_body = { ok: r.ok, status: r.status, text: r.ok ? 'OK' : await r.text().catch(()=> 'text err') };
  } catch (e) {
    out.fedexAuth_body = { ok: false, error: String(e.message || e) };
  }

  return out;
}

/* ---------------- UPS ---------------- */
async function getUpsRates(input) {
  const token = await upsAuth();

  const payload = {
    RateRequest: {
      Request: { TransactionReference: { CustomerContext: 'ME4L Quote' } },
      Shipment: {
        Shipper: { Address: { PostalCode: String(input.origin_zip), CountryCode: 'US' } },
        ShipTo: {
          Address: {
            PostalCode: String(input.dest_zip),
            CountryCode: 'US',
            ResidentialAddressIndicator: input.residential ? '' : undefined,
          },
        },
        Package: [{
          PackagingType: { Code: '02' }, // customer-supplied package
          PackageWeight: { UnitOfMeasurement: { Code: 'LBS' }, Weight: String(input.weight_lb) },
          Dimensions: input.dimensions_in ? {
            UnitOfMeasurement: { Code: 'IN' },
            Length: String(input.dimensions_in.length),
            Width:  String(input.dimensions_in.width),
            Height: String(input.dimensions_in.height)
          } : undefined,
          PackageServiceOptions: input.declared_value ? {
            DeclaredValue: { CurrencyCode: 'USD', MonetaryValue: String(input.declared_value) }
          } : undefined
        }],
        ShipmentRatingOptions: { RateChartIndicator: '' },
        DeliveryTimeInformation: input.ship_date
          ? { PackageBillType: '03', Pickup: { Date: String(input.ship_date).replaceAll('-', '') } }
          : undefined
      }
    }
  };

  const r = await fetch('https://onlinetools.ups.com/api/rating/v2403/Rate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`UPS rate error ${r.status} ${await r.text()}`);
  const j = await r.json();

  const services = j?.RateResponse?.RatedShipment || [];
  return services.map(s => ({
    carrier: 'UPS',
    service_name: s?.Service?.Description || s?.Service?.Code,
    total_charge: Number(s?.TotalCharges?.MonetaryValue ?? 0),
    transit_days: s?.GuaranteedDelivery ? s?.GuaranteedDelivery?.BusinessDaysInTransit : undefined,
    estimated_delivery_date: s?.GuaranteedDelivery ? s?.GuaranteedDelivery?.DeliveryDate : undefined
  }));
}

async function upsAuth() {
  const id = process.env.UPS_CLIENT_ID;
  const secret = process.env.UPS_CLIENT_SECRET;
  if (!id || !secret) throw new Error('UPS credentials missing');
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const r = await fetch('https://www.ups.com/security/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error(`UPS auth failed ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}

/* ---------------- FedEx ---------------- */
async function getFedexRates(input) {
  const token = await fedexAuth();
  const payload = {
    accountNumber: { value: process.env.FEDEX_ACCOUNT_NUMBER || '' },
    requestedShipment: {
      shipper: { address: { postalCode: String(input.origin_zip), countryCode: 'US' } },
      recipient: { address: { postalCode: String(input.dest_zip), countryCode: 'US', residential: !!input.residential } },
      pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      rateRequestType: ['ACCOUNT','LIST'],
      requestedPackageLineItems: [{
        weight: { units:'LB', value:Number(input.weight_lb) },
        dimensions: input.dimensions_in ? {
          length:Number(input.dimensions_in.length), width:Number(input.dimensions_in.width), height:Number(input.dimensions_in.height), units:'IN'
        } : undefined,
        declaredValue: input.declared_value ? { currency:'USD', amount:Number(input.declared_value) } : undefined
      }],
      shipDateStamp: input.ship_date || undefined
    }
  };

  const r = await fetch('https://apis.fedex.com/rate/v1/rates/quotes', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`FedEx rate error ${r.status} ${await r.text()}`);
  const j = await r.json();

  const details = j?.output?.rateReplyDetails || [];
  return details.flatMap(d => {
    const svc = d.serviceName || d.serviceType;
    const amounts = d?.ratedShipmentDetails?.[0]?.totalNetCharge
      || d?.ratedShipmentDetails?.[0]?.shipmentRateDetail?.totalNetChargeWithDutiesAndTaxes;
    const amt = amounts?.amount ?? 0;
    const etd = d?.commit?.dateDetail?.dayFormat || d?.commit?.datesOrTimes?.[0]?.dateOrTimestamp;
    const transit = d?.commit?.transitTime || d?.transitTime;
    return [{
      carrier:'FedEx',
      service_name: svc,
      total_charge: Number(amt),
      transit_days: transit ? parseTransit(transit) : undefined,
      estimated_delivery_date: etd || undefined
    }];
  });
}

async function fedexAuth() {
  const id = process.env.FEDEX_CLIENT_ID;
  const secret = process.env.FEDEX_CLIENT_SECRET;
  if (!id || !secret) throw new Error('FedEx credentials missing');

  // Try Basic header first
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  let r = await fetch('https://apis.fedex.com/oauth/token', {
    method:'POST',
    headers:{ 'Content-Type':'application/x-www-form-urlencoded','Authorization':`Basic ${auth}` },
    body:'grant_type=client_credentials'
  });

  // Fallback: some FedEx accounts require client_id/secret in body
  if (!r.ok) {
    const params = new URLSearchParams();
    params.set('grant_type', 'client_credentials');
    params.set('client_id', id);
    params.set('client_secret', secret);
    r = await fetch('https://apis.fedex.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
  }

  if (!r.ok) throw new Error(`FedEx auth failed ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}

function parseTransit(s){
  const m = /(\w+)_DAYS?/.exec(s||'');
  if(!m) return undefined;
  const map = {ONE:1,TWO:2,THREE:3,FOUR:4,FIVE:5,SIX:6,SEVEN:7};
  return map[m[1]] || undefined;
}
