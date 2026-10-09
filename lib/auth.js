// Optional password gate for the dashboard (HTTP Basic auth). The dashboard is
// open unless DASHBOARD_PASSWORD is set; set it once real callers' details are
// stored, since it shows names, numbers and transcripts.

const crypto = require('crypto');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requirePassword({ required }) {
  return (req, res, next) => {
    // Explicit opt-out: the owner chose to make the dashboard public.
    if (process.env.DASHBOARD_PUBLIC === 'true') return next();
    const password = process.env.DASHBOARD_PASSWORD;
    if (!password) {
      if (!required) return next();
      return res.status(503).type('text').send('Aangan Studio dashboard is locked: set DASHBOARD_PASSWORD in the deployment environment.');
    }
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      const supplied = decoded.slice(decoded.indexOf(':') + 1);
      if (safeEqual(supplied, password)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Aangan Studio", charset="UTF-8"');
    res.status(401).type('text').send('Password required.');
  };
}

module.exports = { requirePassword };
