// ============================================
// VisionTrack — JWT Authentication Middleware
// ============================================
const jwt = require('jsonwebtoken');

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET environment variable is required in production. Refusing to start.');
    process.exit(1);
  } else {
    JWT_SECRET = 'dev_visiontrack_jwt_secret_change_in_production_key_4566';
    console.warn('⚠️ Notice: JWT_SECRET not set. Using development secret. Set JWT_SECRET in .env for production.');
  }
}
const JWT_EXPIRY = '24h';

/**
 * Generate a JWT token for a user.
 * @param {object} user - User object with id, organization_id, role
 * @returns {string} JWT token
 */
function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      organization_id: user.organization_id,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

/**
 * Required authentication middleware.
 * Rejects request with 401 if no valid token is present.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Optional authentication middleware.
 * Attaches req.user if a valid token is present, but does NOT block
 * unauthenticated requests. This allows the simulator and backward-compatible
 * calls to continue working while authenticated users get org-scoped data.
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
  } catch (err) {
    // Invalid token — just proceed without user context
  }
  next();
}

/**
 * Get the list of camera IDs visible to the authenticated user.
 * Returns null if no user is authenticated (= show all data).
 * Super admins also get null (= show all data).
 */
function getOrgCameraFilter(req) {
  if (!req.user) return null;
  if (req.user.role === 'super_admin') return null;
  return req.user.organization_id;
}

module.exports = { generateToken, requireAuth, optionalAuth, getOrgCameraFilter, JWT_SECRET };
