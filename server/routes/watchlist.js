const express = require('express');
const router = express.Router();
const { getDb } = require('../database');

function normalizePlate(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

// GET /api/watchlist — List all watchlist entries
router.get('/', (req, res) => {
  const db = getDb();
  const { type } = req.query; // blacklist or whitelist
  let query = 'SELECT * FROM watchlist WHERE is_active = 1';
  const params = [];
  if (type) { query += ' AND list_type = ?'; params.push(type); }
  query += ' ORDER BY added_on DESC';
  const items = db.prepare(query).all(...params);
  res.json(items);
});

// POST /api/watchlist — Add plate to watchlist
router.post('/', (req, res) => {
  const db = getDb();
  const { plate, reason, added_by, list_type = 'blacklist' } = req.body;
  const normalizedPlate = normalizePlate(plate);
  if (!normalizedPlate) return res.status(400).json({ error: 'Plate is required' });

  try {
    db.prepare(`
      INSERT INTO watchlist (plate, reason, added_by, list_type) VALUES (?, ?, ?, ?)
    `).run(normalizedPlate, reason || 'Not specified', added_by || 'Admin', list_type);

    const item = db.prepare('SELECT * FROM watchlist WHERE plate = ?').get(normalizedPlate);
    res.status(201).json(item);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Plate already in watchlist' });
    }
    throw err;
  }
});

// DELETE /api/watchlist/:id — Remove from watchlist
router.delete('/:id', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE watchlist SET is_active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
