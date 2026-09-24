const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../database');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(requireAuth);

function canManageOrganization(req, organizationId) {
  return req.user.role === 'super_admin' || req.user.organization_id === organizationId;
}

function isOrganizationAdmin(req, organizationId) {
  return req.user.role === 'super_admin'
    || (req.user.organization_id === organizationId && ['admin', 'super_admin'].includes(req.user.role));
}

router.get('/', (req, res) => {
  const db = getDb();
  const organizations = db.prepare(`
    SELECT id, name, city, state, organization_type, status, created_at, parent_organization_id
    FROM organizations ORDER BY name
  `).all();
  res.json(organizations);
});

router.get('/:id/key', (req, res) => {
  if (!canManageOrganization(req, req.params.id)) return res.status(403).json({ error: 'Access denied' });
  const organization = getDb().prepare('SELECT id, name, api_key, link_key FROM organizations WHERE id = ?').get(req.params.id);
  if (!organization) return res.status(404).json({ error: 'Organization not found' });
  res.json(organization);
});

router.post('/:id/regenerate-key', (req, res) => {
  if (!canManageOrganization(req, req.params.id)) return res.status(403).json({ error: 'Access denied' });
  const db = getDb();
  const organization = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(req.params.id);
  if (!organization) return res.status(404).json({ error: 'Organization not found' });
  const apiKey = `anpr_${crypto.randomBytes(24).toString('hex')}`;
  db.prepare('UPDATE organizations SET api_key = ? WHERE id = ?').run(apiKey, req.params.id);
  res.json({ id: organization.id, name: organization.name, api_key: apiKey });
});

router.post('/:id/generate-link-key', (req, res) => {
  if (!isOrganizationAdmin(req, req.params.id)) return res.status(403).json({ error: 'Organization admin access required' });
  const db = getDb();
  const organization = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(req.params.id);
  if (!organization) return res.status(404).json({ error: 'Organization not found' });
  const linkKey = `link_${crypto.randomBytes(16).toString('hex')}`;
  db.prepare('UPDATE organizations SET link_key = ? WHERE id = ?').run(linkKey, req.params.id);
  res.json({ id: organization.id, name: organization.name, link_key: linkKey });
});

router.post('/:id/connect-to-superadmin', (req, res) => {
  if (!isOrganizationAdmin(req, req.params.id) || req.user.organization_id !== req.params.id) {
    return res.status(403).json({ error: 'Organization admin access required' });
  }
  const { superadmin_org_id: superadminOrgId, link_key: linkKey } = req.body || {};
  if (!superadminOrgId || !linkKey) return res.status(400).json({ error: 'superadmin_org_id and link_key are required' });
  if (superadminOrgId === req.params.id) return res.status(400).json({ error: 'An organization cannot connect to itself' });

  const db = getDb();
  const target = db.prepare(`
    SELECT id, name, link_key
    FROM organizations
    WHERE id = ? OR lower(name) = lower(?)
    LIMIT 1
  `).get(superadminOrgId, superadminOrgId);
  if (!target || target.link_key !== linkKey) return res.status(401).json({ error: 'Invalid superadmin organization or link key' });
  db.prepare('UPDATE organizations SET parent_organization_id = ? WHERE id = ?').run(target.id, req.params.id);
  res.json(db.prepare(`
    SELECT id, name, city, state, organization_type, status, created_at, parent_organization_id
    FROM organizations WHERE id = ?
  `).get(req.params.id));
});

router.post('/:id/disconnect-superadmin', (req, res) => {
  if (!isOrganizationAdmin(req, req.params.id) || req.user.organization_id !== req.params.id) {
    return res.status(403).json({ error: 'Organization admin access required' });
  }
  const db = getDb();
  const result = db.prepare('UPDATE organizations SET parent_organization_id = NULL WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Organization not found' });
  res.json(db.prepare(`
    SELECT id, name, city, state, organization_type, status, created_at, parent_organization_id
    FROM organizations WHERE id = ?
  `).get(req.params.id));
});

router.get('/:id/children', (req, res) => {
  if (!canManageOrganization(req, req.params.id)) return res.status(403).json({ error: 'Access denied' });
  const children = getDb().prepare(`
    SELECT id, name, city, state, organization_type, status, created_at, parent_organization_id
    FROM organizations WHERE parent_organization_id = ? ORDER BY name
  `).all(req.params.id);
  res.json(children);
});

module.exports = router;