// ============================================
// VisionTrack — Authentication Routes
// POST /api/auth/login
// GET  /api/auth/me
// ============================================
const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { getDb } = require('../database');
const { findUserByEmail, verifyPassword, hashPassword, updateLastLogin, ensureOrganizationApiKey } = require('../services/authService');
const { generateToken, requireAuth } = require('../middleware/authMiddleware');

const SERVER_URL = process.env.PUBLIC_SERVER_URL || 'http://localhost:3001';

function authResponse(user) {
  const organizationApiKey = ensureOrganizationApiKey(user.organization_id);
  const token = generateToken(user);
  return {
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      organization_id: user.organization_id,
      organization_name: user.organization_name,
      organization_city: user.organization_city,
    },
    connection: {
      api_key: organizationApiKey,
      server_url: SERVER_URL,
      ingest_endpoint: '/api/detections/ingest',
      ingest_url: `${SERVER_URL}/api/detections/ingest`,
    },
  };
}

router.post('/register', (req, res) => {
  const { name, email, password, organization_name: organizationName, city, state, organization_type: organizationType } = req.body || {};
  if (![name, email, password, organizationName, city].every(value => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ error: 'Name, email, password, organization name, and city are required' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const db = getDb();
  const normalizedEmail = email.trim().toLowerCase();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail)) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const organizationId = `ORG-${uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  const userId = `USR-${uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  const organizationApiKey = `orgkey_${crypto.randomBytes(24).toString('hex')}`;
  const insert = db.transaction(() => {
    db.prepare(`
      INSERT INTO organizations (id, name, city, state, organization_type, api_key)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(organizationId, organizationName.trim(), city.trim(), state?.trim() || null, organizationType?.trim() || 'operator', organizationApiKey);
    db.prepare(`
      INSERT INTO users (id, organization_id, name, email, password_hash, role)
      VALUES (?, ?, ?, ?, ?, 'admin')
    `).run(userId, organizationId, name.trim(), normalizedEmail, hashPassword(password));
  });
  insert();

  const user = db.prepare(`
    SELECT u.*, o.name as organization_name, o.city as organization_city
    FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = ?
  `).get(userId);
  return res.status(201).json(authResponse(user));
});

/**
 * POST /api/auth/login
 * Authenticate user with email + password, return JWT + user info.
 */
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  // --- Input validation ---
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid input' });
  }

  // --- Find user ---
  const user = findUserByEmail(email.trim().toLowerCase());
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // --- Verify password ---
  const passwordValid = verifyPassword(password, user.password_hash);
  if (!passwordValid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // --- Check user status ---
  if (user.status !== 'active') {
    return res.status(403).json({ error: 'Account is deactivated' });
  }

  // --- Generate token ---
  // --- Update last login ---
  updateLastLogin(user.id);
  ensureOrganizationApiKey(user.organization_id);

  // --- Return user info (never return password_hash) ---
  res.json(authResponse(user));
});

/**
 * GET /api/auth/me
 * Validate JWT token and return current user info.
 * Used to restore sessions on page refresh.
 */
router.get('/me', requireAuth, (req, res) => {
  const { findUserById } = require('../services/authService');
  const fullUser = findUserById(req.user.id);

  if (!fullUser) {
    return res.status(401).json({ error: 'User not found' });
  }

  if (fullUser.status !== 'active') {
    return res.status(403).json({ error: 'Account is deactivated' });
  }

  const organizationApiKey = ensureOrganizationApiKey(fullUser.organization_id);
  res.json({
    user: {
      id: fullUser.id,
      name: fullUser.name,
      email: fullUser.email,
      role: fullUser.role,
      organization_id: fullUser.organization_id,
      organization_name: fullUser.organization_name,
      organization_city: fullUser.organization_city,
    },
    connection: {
      api_key: organizationApiKey,
      server_url: SERVER_URL,
      ingest_endpoint: '/api/detections/ingest',
      ingest_url: `${SERVER_URL}/api/detections/ingest`,
    },
  });
});

module.exports = router;
