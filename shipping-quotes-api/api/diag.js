// api/diag.js
module.exports = async (req, res) => {
  const out = {
    env: {
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
    if (!out.env.UPS_CLIENT_ID || !out.env.UPS_CLIENT_SECRET) throw new Error('Missing UPS env vars');
    const auth = Buffer.from(`${process.env.UPS_CLIENT_ID}:${process.env.UPS_CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://www.ups.com/security/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
      body: 'grant_type=client_credentials'
    });
    out.upsAuth = { ok: r.ok, status: r.status, text: r.ok ? 'OK' : await r.text().catch(()=> 'text err') };
  } catch (e) {
    out.upsAuth = { ok: false, error: String(e.message || e) };
  }

  try {
    if (!out.env.FEDEX_CLIENT_ID || !out.env.FEDEX_CLIENT_SECRET) throw new Error('Missing FedEx env vars');
    const auth = Buffer.from(`${process.env.FEDEX_CLIENT_ID}:${process.env.FEDEX_CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://apis.fedex.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
      body: 'grant_type=client_credentials'
    });
    out.fedexAuth = { ok: r.ok, status: r.status, text: r.ok ? 'OK' : await r.text().catch(()=> 'text err') };
  } catch (e) {
    out.fedexAuth = { ok: false, error: String(e.message || e) };
  }

  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify(out));
};
