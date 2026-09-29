import { config } from './config.js';

/**
 * Gate for every /admin/* route. Deliberately a shared bearer token (or
 * set of tokens), not a session/account system — see config.js's `admin`
 * block for why. Refuses every request (rather than failing open) when no
 * tokens are configured, so an operator can't accidentally ship this
 * surface wide open by forgetting to configure it.
 */
export function requireAdmin(req, res, next) {
  if (!config.admin.tokens.length) {
    return res.status(503).json({ error: 'admin console not configured (ADMIN_TOKENS unset)' });
  }

  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !config.admin.tokens.includes(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  next();
}
