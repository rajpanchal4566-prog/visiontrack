// ============================================
// VisionTrack — Auth Service Module
// Helper functions for authentication & multi-org
// ============================================
const bcrypt = require('bcryptjs');
const { getDb } = require('../database');
const { v4: uuidv4 } = require('uuid');

const BCRYPT_ROUNDS = 10;

// --- Password Helpers ---

/**
 * Hash a plaintext password using bcrypt.
 * @param {string} plaintext - The plaintext password
 * @returns {string} The bcrypt hash
 */
function hashPassword(plaintext) {
  return bcrypt.hashSync(plaintext, BCRYPT_ROUNDS);
}

/**
 * Verify a plaintext password against a bcrypt hash.
 * @param {string} plaintext - The plaintext password
 * @param {string} hash - The bcrypt hash to compare against
 * @returns {boolean} True if the password matches
 */
function verifyPassword(plaintext, hash) {
  return bcrypt.compareSync(plaintext, hash);
}

// --- User Helpers ---

/**
 * Find a user by email address.
 * @param {string} email
 * @returns {object|undefined} The user row, or undefined if not found
 */
function findUserByEmail(email) {
  const db = getDb();
  return db.prepare(`
    SELECT u.*, o.name as organization_name, o.city as organization_city
    FROM users u
    JOIN organizations o ON u.organization_id = o.id
    WHERE u.email = ?
  `).get(email);
}

/**
 * Find a user by ID.
 * @param {string} id
 * @returns {object|undefined} The user row, or undefined if not found
 */
function findUserById(id) {
  const db = getDb();
  return db.prepare(`
    SELECT u.*, o.name as organization_name, o.city as organization_city
    FROM users u
    JOIN organizations o ON u.organization_id = o.id
    WHERE u.id = ?
  `).get(id);
}

/**
 * Get all users belonging to an organization.
 * @param {string} orgId
 * @returns {object[]} Array of user rows (password_hash excluded)
 */
function getUsersForOrganization(orgId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, organization_id, name, email, role, status, created_at, last_login
    FROM users
    WHERE organization_id = ?
    ORDER BY created_at
  `).all(orgId);
}

/**
 * Create a new user with a hashed password.
 * @param {object} params
 * @param {string} params.name
 * @param {string} params.email
 * @param {string} params.password - Plaintext password (will be hashed)
 * @param {string} params.organizationId
 * @param {string} [params.role='operator']
 * @returns {object} The created user row (without password_hash)
 */
function createUser({ name, email, password, organizationId, role = 'operator' }) {
  const db = getDb();
  const id = `USR-${uuidv4().slice(0, 8).toUpperCase()}`;
  const passwordHash = hashPassword(password);

  db.prepare(`
    INSERT INTO users (id, organization_id, name, email, password_hash, role)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, organizationId, name, email, passwordHash, role);

  return db.prepare(`
    SELECT id, organization_id, name, email, role, status, created_at
    FROM users WHERE id = ?
  `).get(id);
}

/**
 * Update the last_login timestamp for a user.
 * @param {string} userId
 */
function updateLastLogin(userId) {
  const db = getDb();
  db.prepare(`
    UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?
  `).run(userId);
}

// --- Organization Helpers ---

/**
 * Find an organization by ID.
 * @param {string} orgId
 * @returns {object|undefined} The organization row, or undefined if not found
 */
function findOrganization(orgId) {
  const db = getDb();
  return db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
}

function ensureOrganizationApiKey(orgId) {
  const db = getDb();
  const organization = findOrganization(orgId);
  if (!organization) return null;
  if (!organization.api_key) {
    const apiKey = `orgkey_${orgId.toLowerCase()}_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
    db.prepare('UPDATE organizations SET api_key = ? WHERE id = ?').run(apiKey, orgId);
    return apiKey;
  }
  return organization.api_key;
}

/**
 * Find an organization by name.
 * @param {string} name
 * @returns {object|undefined} The organization row, or undefined if not found
 */
function findOrganizationByName(name) {
  const db = getDb();
  return db.prepare('SELECT * FROM organizations WHERE name = ?').get(name);
}

/**
 * Check if a user belongs to a given organization.
 * Super admins are considered to belong to all organizations.
 * @param {string} userId
 * @param {string} orgId
 * @returns {boolean} True if the user belongs to the organization
 */
function checkOrganizationOwnership(userId, orgId) {
  const db = getDb();
  const user = db.prepare('SELECT organization_id, role FROM users WHERE id = ?').get(userId);
  if (!user) return false;

  // Super admins have access to all organizations
  if (user.role === 'super_admin') return true;

  return user.organization_id === orgId;
}

/**
 * Get all organizations.
 * @returns {object[]} Array of organization rows
 */
function getAllOrganizations() {
  const db = getDb();
  return db.prepare('SELECT * FROM organizations ORDER BY name').all();
}

module.exports = {
  hashPassword,
  verifyPassword,
  findUserByEmail,
  findUserById,
  getUsersForOrganization,
  createUser,
  updateLastLogin,
  findOrganization,
  ensureOrganizationApiKey,
  findOrganizationByName,
  checkOrganizationOwnership,
  getAllOrganizations,
};
