// api/shipping/quote.js
// Set Vercel env CARRIER_ENV = "sandbox" or "prod" (default: prod)

module.exports = async (req, res) => {
  // CORS (keep * while testing; restrict later)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const qs = req.query || {};
  const isDemo = String(qs.demo || '') === '1';
  const isDiag = String(qs.diag || '') === '1';

  if (req.method === 'GET') {
    if (isDiag) return res.status(200).json(await diag());
    if (isDemo) return res.status(200).json(demoResponse());
    return res.status(200).json({ ok: true, hint: 'Use ?demo=1 for mock quotes or ?diag=1 for diagnostics.' });
  }

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  if (isDemo) return res.status(200).json(demoResponse());

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const only = (qs.only || '').toString().toLowerCase(); // "ups" or "fedex"

  try {
    const tasks = [];
    const labels = [];
    if (!only || only === 'ups')   { tasks.push(getUpsRates(body));   labels.push('UPS'); }
    if (!only || only === 'fedex') { tasks.push(getFedexRates(body)); labels.push('FedEx'); }

    const settled = await Promise.allSettled(tasks);
    const quotes = [], errors = [];
    settled.forEach((r, i) => {
      const name = labels[i];
      if (r.status === 'fulfilled') quotes.push(...(r.value || []));
      else errors.push(`${name}: ${r.reason?.message || r.reason || 'unknown error'}`);
    });

    if (!quotes.length) {
      return res.status(502).json({ error: 'No rates from carriers', detail: errors.join(' | ') || 'No quotes' });
    }

    quotes.sort((a, b) => a.total_charge - b.total_charge);
    res.status(200).json({ quotes, warnings: errors.length ? errors : undefined });
  } catch (e) {
    res.status(500).json({ error: 'Server failure', detail: e?.message || String(e) });
  }
};

// ---------------- config + helpers ----------------
const ENV = (process.env.CARRIER_ENV || 'prod').toLowerCase();
const UPS_AUTH_HOST  = ENV === 'sandbox' ? 'https://wwwcie.ups.com'         : 'https://www.ups.com';
const UPS_RATE_HOST  = ENV === 'sandbox' ? 'https://wwwcie.ups.com'         : 'https://onlinetools.ups.com';
const FEDEX_API_HOST = ENV === 'sandbox' ? 'https://apis-sandbox.fedex.com' : 'https://apis.fedex.com';

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
function safeParse(s){ try { return JSON.parse(s); } catch { return {}; } }

// Diagnostics: verify env + OAuth on correct hosts
async function diag() {
  const out = {
    env: {
      MODE: ENV,
      UPS_CLIENT_ID: !!process.env.UPS_CLIENT_ID,
      UPS_CLIENT_SECRET: !!process.env.UPS_CLIENT_SECRET,
      FEDEX_CLIENT_ID: !!process.env.FEDEX_CLIENT_ID,
      FEDEX_CLIENT_SECRET: !!process.env.FEDEX_CLIENT_SECRET,
      FEDEX_ACCOUNT_NUMBER: !!process.env.FEDEX_ACCOUNT_NUMBER,
      UPS_ACCOUNT_NUMBER: !!process.env.UPS_ACCOUNT_NUMBER
    },
    upsAuth: null,
    fedexAuth: null
  };

  try {
    const auth = Buffer.from(`${process.env.UPS_CLIENT_ID}:${process.env.UPS_CLIENT_SECRET}`).toString('base64');
    const r = await fetch(`${UPS_AUTH_HOST}/security/v1/oauth/token`, {
      method:'POST',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'Authorization':`Basic ${auth}` },
      body:'grant_type=client_credentials'
    });
    out.upsAuth = { ok: r.ok, status: r.status, text: r.ok ? 'OK' : await r.text().catch(()=> 'text err') };
  } catch (e) {
    out.upsAuth = { ok:false, error:String(e.message||e) };
  }

  try {
    // Try Basic header first, then body creds
    const auth = Buffer.from(`${process.env.FEDEX_CLIENT_ID}:${process.env.FEDEX_CLIENT_SECRET}`).toString('base64');
    let r = await fetch(`${FEDEX_API_HOST}/oauth/token`, {
      method:'POST',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'Authorization':`Basic ${auth}` },
      body:'grant_type=client_credentials'
    });
    if (!r.ok) {
      const params = new URLSearchParams();
      params.set('grant_type','client_credentials');
      params.set('client_id', process.env.FEDEX_CLIENT_ID || '');
      params.set('client_secret', process.env.FEDEX_CLIENT_SECRET || '');
      r = await fetch(`${FEDEX_API_HOST}/oauth/token`, {
        method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body: params.toString()
      });
    }
    out.fedexAuth = { ok: r.ok, status: r.status, text: r.ok ? 'OK' : await r.text().catch(()=> 'text err') };
  } catch (e) {
    out.fedexAuth = { ok:false, error:String(e.message||e) };
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
        Shipper: {
          ShipperNumber: process.env.UPS_ACCOUNT_NUMBER || undefined,  // helps sandbox
          Address: {
            PostalCode: String(input.origin_zip),
            CountryCode: 'US',
            StateProvinceCode: input.origin_state || undefined          // optional but helps sandbox
          }
        },
        // UPS sandbox often prefers explicit ShipFrom
        ShipFrom: {
          Address: {
            PostalCode: String(input.origin_zip),
            CountryCode: 'US',
            StateProvinceCode: input.origin_state || undefined
          }
        },
        ShipTo: {
          Address: {
            PostalCode: String(input.dest_zip),
            CountryCode: 'US',
            StateProvinceCode: input.dest_state || undefined,           // optional
            ResidentialAddressIndicator: input.residential ? '' : undefined
          }
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

  const r = await fetch(`${UPS_RATE_HOST}/api/rating/v2403/Rate`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` },
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
  const id = process.env.UPS_CLIENT_ID, secret = process.env.UPS_CLIENT_SECRET;
  if (!id || !secret) throw new Error('UPS credentials missing');
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const r = await fetch(`${UPS_AUTH_HOST}/security/v1/oauth/token`, {
    method:'POST',
    headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'Authorization':`Basic ${auth}` },
    body:'grant_type=client_credentials'
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
      shipper:   { address: { postalCode: String(input.origin_zip), countryCode: 'US' } },
      recipient: { address: { postalCode: String(input.dest_zip),   countryCode: 'US', residential: !!input.residential } },
      pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      rateRequestType: ['ACCOUNT','LIST'],
      requestedPackageLineItems: [{
        weight: { units:'LB', value:Number(input.weight_lb) },
        dimensions: input.dimensions_in ? {
          length: Number(input.dimensions_in.length),
          width:  Number(input.dimensions_in.width),
          height: Number(input.dimensions_in.height),
          units: 'IN'
        } : undefined,
        declaredValue: input.declared_value ? { currency:'USD', amount:Number(input.declared_value) } : undefined
      }],
      shipDateStamp: input.ship_date || undefined
    }
  };

  const r = await fetch(`${FEDEX_API_HOST}/rate/v1/rates/quotes`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`FedEx rate error ${r.status} ${await r.text()}`);
  const j = await r.json();

  const details = j?.output?.rateReplyDetails || [];
  return details.flatMap(d => {
    const svc = d.serviceName || d.serviceType;
    const amounts =
      d?.ratedShipmentDetails?.[0]?.totalNetCharge ||
      d?.ratedShipmentDetails?.[0]?.shipmentRateDetail?.totalNetChargeWithDutiesAndTaxes;
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
  const id = process.env.FEDEX_CLIENT_ID, secret = process.env.FEDEX_CLIENT_SECRET;
  if (!id || !secret) throw new Error('FedEx credentials missing');

  // Try Basic header first, then fall back to body credentials
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  let r = await fetch(`${FEDEX_API_HOST}/oauth/token`, {
    method:'POST',
    headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'Authorization':`Basic ${basic}` },
    body:'grant_type=client_credentials'
  });
  if (!r.ok) {
    const params = new URLSearchParams();
    params.set('grant_type', 'client_credentials');
    params.set('client_id', id);
    params.set('client_secret', secret);
    r = await fetch(`${FEDEX_API_HOST}/oauth/token`, {
      method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body: params.toString()
    });
  }
  if (!r.ok) throw new Error(`FedEx auth failed ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}

function parseTransit(s) {
  const m = /(\w+)_DAYS?/.exec(s || ''); if (!m) return undefined;
  const map = { ONE:1, TWO:2, THREE:3, FOUR:4, FIVE:5, SIX:6, SEVEN:7 };
  return map[m[1]] || undefined;
}

