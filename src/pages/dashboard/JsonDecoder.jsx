import { useState, useEffect, useCallback } from 'react';
import {
  FileJson, Search, ShieldAlert, ShieldCheck, ShieldX, Flag, Plus, X, Check,
  Clock, Camera, AlertTriangle, Upload, Trash2, History, ChevronDown, Edit3,
  Zap, Eye, Crosshair, Ban, CircleAlert, CircleDot
} from 'lucide-react';
import { decodeApi } from '../../services/api';
import './JsonDecoder.css';

// ── Sample JSON Templates ──────────────────────────────
const TEMPLATES = {
  generic: {
    plate_number: "MH-12-AB-1234",
    confidence: 0.96,
    vehicle_type: "Sedan",
    vehicle_color: "White",
    speed: 67,
    direction: "Northbound",
    camera_id: "CAM-001",
    camera_name: "Highway Checkpoint Alpha",
    timestamp: new Date().toISOString(),
    event_id: "evt-demo-001",
    location_id: "Zone-A1",
  },
  hikvision: {
    plateNumber: "DL-01-CA-5678",
    score: 0.94,
    vehicleType: "SUV",
    vehicleColor: "Black",
    speed_kmh: 82,
    travelDirection: "Southbound",
    deviceId: "CAM-003",
    deviceName: "Toll Gate Camera 3",
    captureTime: new Date().toISOString(),
    transactionId: "txn-hik-0042",
  },
  dahua: {
    license_plate: "MP-09-XY-9012",
    accuracy: 0.91,
    vehicle_class: "Truck",
    colour: "Red",
    vehicle_speed: 45,
    heading: "Eastbound",
    sensor_id: "CAM-007",
    source_name: "Industrial Zone Entry",
    event_time: new Date().toISOString(),
    location: "Zone-C3",
    violations: ["overweight", "no_fastag"],
  },
  batch: [
    {
      plate_number: "RJ-14-CD-3456",
      confidence: 0.89,
      vehicle_type: "Bike",
      speed: 55,
      camera_id: "CAM-002",
      timestamp: new Date().toISOString(),
    },
    {
      plate_number: "KA-01-MN-7890",
      confidence: 0.97,
      vehicle_type: "Bus",
      vehicle_color: "Yellow",
      speed: 38,
      camera_id: "CAM-004",
      timestamp: new Date().toISOString(),
    },
  ],
};

const FLAG_TYPE_LABELS = {
  stolen: { label: 'Stolen', icon: Ban, color: 'danger' },
  wanted: { label: 'Wanted', icon: Crosshair, color: 'danger' },
  expired_registration: { label: 'Expired Reg.', icon: Clock, color: 'warning' },
  traffic_violation: { label: 'Violation', icon: AlertTriangle, color: 'warning' },
  insurance_lapsed: { label: 'No Insurance', icon: ShieldX, color: 'warning' },
  tax_defaulter: { label: 'Tax Default', icon: CircleAlert, color: 'warning' },
  suspicious: { label: 'Suspicious', icon: Eye, color: 'info' },
  custom: { label: 'Custom', icon: Flag, color: 'info' },
};

const SEVERITY_ICONS = {
  critical: { icon: ShieldX, label: '🔴 CRITICAL — IMMEDIATE ACTION REQUIRED', color: 'critical' },
  high: { icon: ShieldAlert, label: '🟠 HIGH — FLAG HIT', color: 'high' },
  warning: { icon: AlertTriangle, label: '🟡 WARNING — FLAGGED', color: 'warning' },
  info: { icon: CircleDot, label: '🔵 INFO — FLAGGED', color: 'info' },
};

export default function JsonDecoder() {
  const [activeTab, setActiveTab] = useState('decode');
  const [jsonInput, setJsonInput] = useState('');
  const [jsonValid, setJsonValid] = useState(null); // null = empty, true = valid, false = invalid
  const [decoding, setDecoding] = useState(false);
  const [decodeResults, setDecodeResults] = useState(null);
  const [decodeError, setDecodeError] = useState('');

  // Flags tab
  const [flags, setFlags] = useState([]);
  const [flagStats, setFlagStats] = useState([]);
  const [flagFilter, setFlagFilter] = useState('all');
  const [showAddFlagModal, setShowAddFlagModal] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [newFlag, setNewFlag] = useState({ plate: '', flag_type: 'stolen', severity: 'critical', description: '', issuing_authority: '', case_number: '' });
  const [bulkText, setBulkText] = useState('');
  const [bulkFlagType, setBulkFlagType] = useState('stolen');
  const [bulkSeverity, setBulkSeverity] = useState('critical');

  // History tab
  const [history, setHistory] = useState([]);
  const [historyTotal, setHistoryTotal] = useState(0);

  // Validate JSON on input change
  useEffect(() => {
    if (!jsonInput.trim()) { setJsonValid(null); return; }
    try {
      JSON.parse(jsonInput);
      setJsonValid(true);
    } catch {
      setJsonValid(false);
    }
  }, [jsonInput]);

  // Fetch flags
  const fetchFlags = useCallback(async () => {
    try {
      const data = await decodeApi.getFlags(flagFilter === 'all' ? undefined : flagFilter);
      setFlags(data.flags || []);
      setFlagStats(data.stats || []);
    } catch (err) { console.error('Failed to fetch flags:', err); }
  }, [flagFilter]);

  useEffect(() => { fetchFlags(); }, [fetchFlags]);

  // Fetch history
  const fetchHistory = useCallback(async () => {
    try {
      const data = await decodeApi.getLog(50);
      setHistory(data.logs || []);
      setHistoryTotal(data.total || 0);
    } catch (err) { console.error('Failed to fetch history:', err); }
  }, []);

  useEffect(() => {
    if (activeTab === 'history') fetchHistory();
  }, [activeTab, fetchHistory]);

  // ── Decode handler ──
  async function handleDecode() {
    if (!jsonInput.trim() || !jsonValid) return;
    setDecoding(true);
    setDecodeError('');
    try {
      const parsed = JSON.parse(jsonInput);
      const result = await decodeApi.decode(parsed);
      setDecodeResults(result);
    } catch (err) {
      console.error('Decode failed:', err);
      setDecodeError(err.message || 'Unable to decode this camera payload.');
    } finally {
      setDecoding(false);
    }
  }

  // ── Template handler ──
  function loadTemplate(key) {
    setJsonInput(JSON.stringify(TEMPLATES[key], null, 2));
    setDecodeResults(null);
    setDecodeError('');
  }

  // ── Add flag handler ──
  async function handleAddFlag() {
    if (!newFlag.plate || !newFlag.flag_type) return;
    try {
      await decodeApi.addFlag(newFlag);
      setShowAddFlagModal(false);
      setNewFlag({ plate: '', flag_type: 'stolen', severity: 'critical', description: '', issuing_authority: '', case_number: '' });
      fetchFlags();
    } catch (err) { alert(err.message); }
  }

  // ── Remove flag handler ──
  async function handleRemoveFlag(id) {
    try {
      await decodeApi.removeFlag(id);
      fetchFlags();
    } catch (err) { console.error('Failed to remove flag:', err); }
  }

  // ── Bulk import handler ──
  async function handleBulkImport() {
    const plates = bulkText.split(/[\n,;]+/).map(p => p.trim()).filter(Boolean);
    if (plates.length === 0) return;
    try {
      const result = await decodeApi.bulkImport({ plates, flag_type: bulkFlagType, severity: bulkSeverity });
      alert(`Successfully imported ${result.imported} plates`);
      setShowBulkModal(false);
      setBulkText('');
      fetchFlags();
    } catch (err) { alert(err.message); }
  }

  // ── Count line numbers for editor ──
  const lineCount = Math.max((jsonInput.match(/\n/g) || []).length + 1, 20);

  return (
    <div className="json-decoder animate-fade-in">
      {/* Tab Navigation */}
      <div className="decoder-tabs">
        <button className={`decoder-tabs__tab ${activeTab === 'decode' ? 'decoder-tabs__tab--active' : ''}`} onClick={() => setActiveTab('decode')}>
          <FileJson size={16} /> Decode
        </button>
        <button className={`decoder-tabs__tab ${activeTab === 'flags' ? 'decoder-tabs__tab--active' : ''}`} onClick={() => setActiveTab('flags')}>
          <Flag size={16} /> Flagged Vehicles
          <span className="decoder-tabs__badge">{flags.length}</span>
        </button>
        <button className={`decoder-tabs__tab ${activeTab === 'history' ? 'decoder-tabs__tab--active' : ''}`} onClick={() => setActiveTab('history')}>
          <History size={16} /> Decode History
          <span className="decoder-tabs__badge">{historyTotal}</span>
        </button>
      </div>

      {/* ════════════════════════════════════════════ */}
      {/*   DECODE TAB                                */}
      {/* ════════════════════════════════════════════ */}
      {activeTab === 'decode' && (
        <div className="decode-panel">
          {/* Left — JSON Input */}
          <div className="decode-input card">
            <div className="decode-input__header">
              <span className="decode-input__title"><FileJson size={16} /> Raw Camera JSON</span>
              <div className="decode-input__templates">
                <button className="decode-input__template-btn" onClick={() => loadTemplate('generic')}>Generic</button>
                <button className="decode-input__template-btn" onClick={() => loadTemplate('hikvision')}>Hikvision</button>
                <button className="decode-input__template-btn" onClick={() => loadTemplate('dahua')}>Dahua</button>
                <button className="decode-input__template-btn" onClick={() => loadTemplate('batch')}>Batch</button>
              </div>
            </div>

            <div className="decode-input__editor">
              <textarea
                className="decode-input__textarea"
                value={jsonInput}
                onChange={e => setJsonInput(e.target.value)}
                placeholder={`Paste raw camera JSON here...\n\nExample:\n{\n  "plate_number": "MH-12-AB-1234",\n  "confidence": 0.96,\n  "vehicle_type": "Sedan",\n  "camera_id": "CAM-001"\n}`}
                spellCheck={false}
              />
            </div>

            <div className="decode-input__actions">
              <button className="btn btn-primary btn-lg" onClick={handleDecode} disabled={decoding || !jsonValid}>
                <Zap size={16} /> {decoding ? 'Decoding...' : 'Decode & Check'}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => { setJsonInput(''); setDecodeResults(null); setDecodeError(''); }}>
                <Trash2 size={14} /> Clear
              </button>
              <span className={`decode-input__status ${jsonValid === true ? 'decode-input__status--valid' : ''} ${jsonValid === false ? 'decode-input__status--invalid' : ''}`}>
                {jsonValid === null ? '' : jsonValid ? '✓ Valid JSON' : '✗ Invalid JSON'}
              </span>
            </div>
          </div>

          {/* Right — Decoded Output */}
          <div className="decode-output">
            {!decodeResults && (
              <div className="decode-output__empty card">
                <Search size={48} />
                <h4>No Data Decoded</h4>
                <p>Paste raw camera JSON on the left and click "Decode & Check" to see results</p>
              </div>
            )}

            {decodeResults && decodeResults.results.map((item, idx) => (
              <div key={idx} className="card" style={{ animation: `fadeInUp ${0.3 + idx * 0.1}s ease` }}>
                {/* Plate Display */}
                <div className="plate-display">
                  <div className="plate-display__row">
                    <span className={`plate-display__plate ${item.flag_result?.flagged ? 'plate-display__plate--flagged' : ''}`}>
                      {item.decoded?.plate || '— NO PLATE —'}
                    </span>
                    {item.flag_result?.flags?.map((f, fi) => (
                      <span key={fi} className={`flag-chip flag-chip--${f.type}`}>
                        {FLAG_TYPE_LABELS[f.type]?.label || f.type}
                      </span>
                    ))}
                  </div>

                  {/* Flag Status Banner */}
                  {item.flag_result?.flagged ? (
                    <div className={`flag-status flag-status--${item.flag_result.highest_severity}`}>
                      <ShieldX size={20} className="flag-status__icon" />
                      <div className="flag-status__details">
                        <span>{SEVERITY_ICONS[item.flag_result.highest_severity]?.label || 'FLAGGED'}</span>
                        {item.flag_result.flags.map((f, fi) => (
                          <span key={fi} className="flag-status__label">
                            {f.type.replace(/_/g, ' ')} — {f.description || f.issuing_authority || 'No details'}
                            {f.case_number ? ` (Case: ${f.case_number})` : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : item.decoded?.plate ? (
                    <div className="flag-status flag-status--clear">
                      <ShieldCheck size={20} className="flag-status__icon" />
                      <span>✅ CLEAR — No flags or watchlist matches</span>
                    </div>
                  ) : null}
                </div>

                {/* Decoded Details Grid */}
                {item.decoded && (
                  <div className="decoded-details" style={{ marginTop: 'var(--space-md)' }}>
                    <div className="decoded-detail">
                      <span className="decoded-detail__label">Vehicle Type</span>
                      <span className="decoded-detail__value">{item.decoded.vehicle_type || '—'}</span>
                    </div>
                    <div className="decoded-detail">
                      <span className="decoded-detail__label">Color</span>
                      <span className="decoded-detail__value">{item.decoded.vehicle_color || '—'}</span>
                    </div>
                    <div className="decoded-detail">
                      <span className="decoded-detail__label">Confidence</span>
                      <span className="decoded-detail__value decoded-detail__value--primary">
                        {item.decoded.confidence <= 1 ? `${(item.decoded.confidence * 100).toFixed(1)}%` : `${item.decoded.confidence}%`}
                      </span>
                    </div>
                    <div className="decoded-detail">
                      <span className="decoded-detail__label">Speed</span>
                      <span className="decoded-detail__value decoded-detail__value--mono">
                        {item.decoded.speed !== null && item.decoded.speed !== undefined ? `${item.decoded.speed} km/h` : '—'}
                      </span>
                    </div>
                    <div className="decoded-detail">
                      <span className="decoded-detail__label">Direction</span>
                      <span className="decoded-detail__value">{item.decoded.direction || '—'}</span>
                    </div>
                    <div className="decoded-detail">
                      <span className="decoded-detail__label">Camera</span>
                      <span className="decoded-detail__value" style={{ fontSize: '0.75rem' }}>
                        {item.decoded.camera_info?.name || item.decoded.camera_id || '—'}
                      </span>
                    </div>
                    <div className="decoded-detail">
                      <span className="decoded-detail__label">Timestamp</span>
                      <span className="decoded-detail__value" style={{ fontSize: '0.7rem' }}>
                        {item.decoded.timestamp ? new Date(item.decoded.timestamp).toLocaleString() : '—'}
                      </span>
                    </div>
                    <div className="decoded-detail">
                      <span className="decoded-detail__label">Event ID</span>
                      <span className="decoded-detail__value decoded-detail__value--mono" style={{ fontSize: '0.7rem' }}>
                        {item.decoded.event_id || '—'}
                      </span>
                    </div>
                    {item.decoded.violations?.length > 0 && (
                      <div className="decoded-detail" style={{ gridColumn: 'span 2' }}>
                        <span className="decoded-detail__label">Violations</span>
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
                          {item.decoded.violations.map((v, vi) => (
                            <span key={vi} className="badge badge-warning">{String(v).replace(/_/g, ' ')}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {item.decoded?.image_data && (
                  <div className="decoded-image">
                    <span className="decoded-detail__label">Camera Image</span>
                    <a href={item.decoded.image_data} target="_blank" rel="noreferrer">
                      <img src={item.decoded.image_data} alt={`Vehicle ${item.decoded.plate || 'capture'}`} />
                    </a>
                  </div>
                )}

                {/* Raw Fields Found */}
                {item.raw_fields_found && (
                  <div style={{ marginTop: 'var(--space-md)', padding: 'var(--space-sm) var(--space-md)', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                    <strong>Fields parsed:</strong> {item.raw_fields_found.join(', ')}
                  </div>
                )}

                {item.error && (
                  <div className="flag-status flag-status--warning" style={{ marginTop: 'var(--space-md)' }}>
                    <AlertTriangle size={16} />
                    <span>{item.error}</span>
                  </div>
                )}
              </div>
            ))}

            {/* Summary bar for batch decodes */}
            {decodeResults && decodeResults.total > 1 && (
              <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'var(--space-md) var(--space-lg)' }}>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: '0.8rem' }}>Batch Summary</span>
                <div style={{ display: 'flex', gap: 'var(--space-lg)' }}>
                  <span style={{ fontSize: '0.8rem' }}>Total: <strong style={{ color: 'var(--primary)' }}>{decodeResults.total}</strong></span>
                  <span style={{ fontSize: '0.8rem' }}>Flagged: <strong style={{ color: decodeResults.flagged_count > 0 ? 'var(--danger)' : 'var(--success)' }}>{decodeResults.flagged_count}</strong></span>
                  <span style={{ fontSize: '0.8rem' }}>Clear: <strong style={{ color: 'var(--success)' }}>{decodeResults.total - decodeResults.flagged_count}</strong></span>
                </div>
              </div>
            )}

            {decodeError && (
              <div className="flag-status flag-status--warning decode-error">
                <AlertTriangle size={16} />
                <span>{decodeError}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════ */}
      {/*   FLAGS TAB                                 */}
      {/* ════════════════════════════════════════════ */}
      {activeTab === 'flags' && (
        <div className="flags-panel">
          {/* Stats Row */}
          <div className="flag-stats stagger-children">
            <div className="flag-stat">
              <span className="flag-stat__label">Total Active</span>
              <span className="flag-stat__value">{flags.length}</span>
            </div>
            {Object.entries(FLAG_TYPE_LABELS).map(([key, meta]) => {
              const count = flagStats.find(s => s.flag_type === key)?.count || 0;
              return (
                <div className="flag-stat" key={key}>
                  <span className="flag-stat__label">{meta.label}</span>
                  <span className={`flag-stat__value flag-stat__value--${meta.color}`}>{count}</span>
                </div>
              );
            })}
          </div>

          {/* Filters + Actions */}
          <div className="flags-header">
            <div className="flag-type-filters">
              <button className={`flag-type-filter ${flagFilter === 'all' ? 'flag-type-filter--active' : ''}`} onClick={() => setFlagFilter('all')}>All</button>
              {Object.entries(FLAG_TYPE_LABELS).map(([key, meta]) => (
                <button key={key} className={`flag-type-filter ${flagFilter === key ? 'flag-type-filter--active' : ''}`} onClick={() => setFlagFilter(key)}>
                  {meta.label}
                </button>
              ))}
            </div>
            <div className="flags-header__actions">
              <button className="btn btn-primary btn-sm" onClick={() => setShowAddFlagModal(true)}>
                <Plus size={14} /> Flag Vehicle
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowBulkModal(true)}>
                <Upload size={14} /> Bulk Import
              </button>
            </div>
          </div>

          {/* Flags Table */}
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Plate</th>
                  <th>Flag Type</th>
                  <th>Severity</th>
                  <th>Description</th>
                  <th>Authority</th>
                  <th>Case #</th>
                  <th>Flagged On</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {flags.map(flag => (
                  <tr key={flag.id}>
                    <td><span className="mono" style={{ color: 'var(--danger)', fontWeight: 700 }}>{flag.plate}</span></td>
                    <td><span className={`flag-chip flag-chip--${flag.flag_type}`}>{FLAG_TYPE_LABELS[flag.flag_type]?.label || flag.flag_type}</span></td>
                    <td><span className={`badge badge-${flag.severity === 'critical' ? 'danger' : flag.severity === 'high' ? 'warning' : flag.severity === 'warning' ? 'warning' : 'info'}`}>{flag.severity?.toUpperCase()}</span></td>
                    <td style={{ fontSize: '0.8rem', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flag.description || '—'}</td>
                    <td style={{ fontSize: '0.8rem' }}>{flag.issuing_authority || '—'}</td>
                    <td style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>{flag.case_number || '—'}</td>
                    <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{new Date(flag.flagged_on).toLocaleDateString()}</td>
                    <td><button className="btn btn-sm btn-danger" onClick={() => handleRemoveFlag(flag.id)}><X size={12} /> Remove</button></td>
                  </tr>
                ))}
                {flags.length === 0 && (
                  <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem' }}>No flagged vehicles. Click "Flag Vehicle" to add one.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════ */}
      {/*   HISTORY TAB                               */}
      {/* ════════════════════════════════════════════ */}
      {activeTab === 'history' && (
        <div className="history-panel">
          <div className="history-panel__header">
            <span className="history-panel__title"><History size={16} /> Decode Audit Log</span>
            <button className="btn btn-secondary btn-sm" onClick={fetchHistory}>
              <Zap size={14} /> Refresh
            </button>
          </div>

          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Timestamp</th>
                  <th>Plate</th>
                  <th>Camera</th>
                  <th>Flag Hit</th>
                  <th>Flag Details</th>
                  <th>Raw JSON</th>
                </tr>
              </thead>
              <tbody>
                {history.map((log, i) => (
                  <tr key={log.id}>
                    <td style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{log.id}</td>
                    <td><span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}><Clock size={12} />{new Date(log.received_at).toLocaleString()}</span></td>
                    <td><span className="mono" style={{ color: log.flag_hit ? 'var(--danger)' : 'var(--primary)', fontWeight: 700 }}>{log.decoded_plate || '—'}</span></td>
                    <td style={{ fontSize: '0.8rem' }}><span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><Camera size={12} style={{ color: 'var(--text-muted)' }} />{log.camera_id || '—'}</span></td>
                    <td>
                      <span className={`history-flag-hit history-flag-hit--${log.flag_hit ? 'yes' : 'no'}`}>
                        {log.flag_hit ? <><ShieldX size={14} /> FLAGGED</> : <><ShieldCheck size={14} /> CLEAR</>}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.75rem', color: 'var(--text-muted)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {log.flag_details ? (() => {
                        try {
                          const parsed = JSON.parse(log.flag_details);
                          return parsed.map(f => f.type?.replace(/_/g, ' ')).join(', ');
                        } catch { return log.flag_details; }
                      })() : '—'}
                    </td>
                    <td><span className="history-json-preview" title={log.raw_json}>{log.raw_json}</span></td>
                  </tr>
                ))}
                {history.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem' }}>No decode operations yet. Decode some JSON to see the audit trail.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════ */}
      {/*   ADD FLAG MODAL                            */}
      {/* ════════════════════════════════════════════ */}
      {showAddFlagModal && (
        <div className="modal-overlay" onClick={() => setShowAddFlagModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal__header">
              <h3>Flag a Vehicle</h3>
              <button className="btn-icon" onClick={() => setShowAddFlagModal(false)}><X size={18} /></button>
            </div>
            <div className="modal__body">
              <div className="flag-form">
                <div className="form-group">
                  <label className="form-label">License Plate Number</label>
                  <input type="text" placeholder="e.g., MH-12-AB-1234" value={newFlag.plate} onChange={e => setNewFlag({ ...newFlag, plate: e.target.value })} />
                </div>
                <div className="flag-form__row">
                  <div className="form-group">
                    <label className="form-label">Flag Type</label>
                    <select value={newFlag.flag_type} onChange={e => setNewFlag({ ...newFlag, flag_type: e.target.value })}>
                      {Object.entries(FLAG_TYPE_LABELS).map(([key, meta]) => (
                        <option key={key} value={key}>{meta.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Severity</label>
                    <select value={newFlag.severity} onChange={e => setNewFlag({ ...newFlag, severity: e.target.value })}>
                      <option value="critical">Critical</option>
                      <option value="high">High</option>
                      <option value="warning">Warning</option>
                      <option value="info">Info</option>
                    </select>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Description / Reason</label>
                  <input type="text" placeholder="e.g., Reported stolen on 12/09/2026" value={newFlag.description} onChange={e => setNewFlag({ ...newFlag, description: e.target.value })} />
                </div>
                <div className="flag-form__row">
                  <div className="form-group">
                    <label className="form-label">Issuing Authority</label>
                    <input type="text" placeholder="e.g., Traffic Authority" value={newFlag.issuing_authority} onChange={e => setNewFlag({ ...newFlag, issuing_authority: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Case Number</label>
                    <input type="text" placeholder="e.g., FIR-2026-0421" value={newFlag.case_number} onChange={e => setNewFlag({ ...newFlag, case_number: e.target.value })} />
                  </div>
                </div>
              </div>
            </div>
            <div className="modal__footer">
              <button className="btn btn-secondary" onClick={() => setShowAddFlagModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAddFlag}><Plus size={14} /> Flag Vehicle</button>
            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════ */}
      {/*   BULK IMPORT MODAL                         */}
      {/* ════════════════════════════════════════════ */}
      {showBulkModal && (
        <div className="modal-overlay" onClick={() => setShowBulkModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal__header">
              <h3>Bulk Import Flagged Plates</h3>
              <button className="btn-icon" onClick={() => setShowBulkModal(false)}><X size={18} /></button>
            </div>
            <div className="modal__body">
              <div className="flag-form">
                <div className="flag-form__row">
                  <div className="form-group">
                    <label className="form-label">Flag Type</label>
                    <select value={bulkFlagType} onChange={e => setBulkFlagType(e.target.value)}>
                      {Object.entries(FLAG_TYPE_LABELS).map(([key, meta]) => (
                        <option key={key} value={key}>{meta.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Severity</label>
                    <select value={bulkSeverity} onChange={e => setBulkSeverity(e.target.value)}>
                      <option value="critical">Critical</option>
                      <option value="high">High</option>
                      <option value="warning">Warning</option>
                      <option value="info">Info</option>
                    </select>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Plate Numbers (one per line, or comma-separated)</label>
                  <textarea
                    className="bulk-import__textarea"
                    value={bulkText}
                    onChange={e => setBulkText(e.target.value)}
                    placeholder={"MH-12-AB-1234\nDL-01-CA-5678\nMP-09-XY-9012"}
                  />
                  <span className="bulk-import__hint">
                    {bulkText.split(/[\n,;]+/).filter(p => p.trim()).length} plates detected
                  </span>
                </div>
              </div>
            </div>
            <div className="modal__footer">
              <button className="btn btn-secondary" onClick={() => setShowBulkModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleBulkImport}><Upload size={14} /> Import All</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
