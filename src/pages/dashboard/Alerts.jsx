import { useState, useEffect } from 'react';
import { AlertTriangle, Filter, Plus, X, Check, Clock, Camera, Volume2 } from 'lucide-react';
import { alertsApi, watchlistApi } from '../../services/api';
import { onNewAlert } from '../../services/socket';
import './Alerts.css';


export default function Alerts() {
  const [alerts, setAlerts] = useState([]);
  const [blacklist, setBlacklist] = useState([]);
  const [whitelist, setWhitelist] = useState([]);
  const [filter, setFilter] = useState('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [activeTab, setActiveTab] = useState('alerts');
  const [newPlate, setNewPlate] = useState('');
  const [newReason, setNewReason] = useState('');
  const [newAddedBy, setNewAddedBy] = useState('');
  const [realtimeAlert, setRealtimeAlert] = useState(null);

  // Fetch data
  useEffect(() => {
    async function fetchData() {
      try {
        const [alts, bl, wl] = await Promise.all([
          alertsApi.getAll({ limit: 50 }),
          watchlistApi.getAll('blacklist'),
          watchlistApi.getAll('whitelist'),
        ]);
        setAlerts(alts);
        setBlacklist(bl);
        setWhitelist(wl);
      } catch (err) { console.error('Failed to fetch alerts:', err); }
    }
    fetchData();
  }, []);

  // Real-time alerts
  useEffect(() => {
    const unsub = onNewAlert((alert) => {
      setAlerts(prev => [alert, ...prev]);
      setRealtimeAlert(alert);
      // Auto-dismiss popup after 10 seconds
      setTimeout(() => setRealtimeAlert(null), 10000);
    });
    return unsub;
  }, []);

  const filteredAlerts = filter === 'all' ? alerts : alerts.filter(a => a.severity === filter);
  const severityCounts = {
    all: alerts.length,
    critical: alerts.filter(a => a.severity === 'critical').length,
    warning: alerts.filter(a => a.severity === 'warning').length,
    info: alerts.filter(a => a.severity === 'info').length,
  };

  async function handleResolve(alertId) {
    try {
      await alertsApi.resolve(alertId);
      setAlerts(prev => prev.map(a => a.id === alertId ? { ...a, status: 'resolved' } : a));
    } catch (err) { console.error('Failed to resolve:', err); }
  }

  async function handleAddToList() {
    if (!newPlate) return;
    const listType = activeTab === 'blacklist' ? 'blacklist' : 'whitelist';
    try {
      const item = await watchlistApi.add({
        plate: newPlate, reason: newReason, added_by: newAddedBy || 'Admin', list_type: listType,
      });
      if (listType === 'blacklist') setBlacklist(prev => [item, ...prev]);
      else setWhitelist(prev => [item, ...prev]);
      setShowAddModal(false);
      setNewPlate(''); setNewReason(''); setNewAddedBy('');
    } catch (err) { alert(err.message); }
  }

  async function handleRemoveFromList(id, listType) {
    try {
      await watchlistApi.remove(id);
      if (listType === 'blacklist') setBlacklist(prev => prev.filter(i => i.id !== id));
      else setWhitelist(prev => prev.filter(i => i.id !== id));
    } catch (err) { console.error('Failed to remove:', err); }
  }

  return (
    <div className="alerts-page animate-fade-in">
      {/* Real-time Alert Popup */}
      {realtimeAlert && (
        <div className="realtime-alert-popup animate-slide-right">
          <div className="realtime-alert-popup__header">
            <Volume2 size={18} className="realtime-alert-popup__icon" />
            <span>🚨 WATCHLIST VEHICLE DETECTED</span>
            <button onClick={() => setRealtimeAlert(null)}><X size={16} /></button>
          </div>
          <div className="realtime-alert-popup__body">
            <span className="mono" style={{ color: 'var(--danger)', fontSize: '1.2rem', fontWeight: 800 }}>{realtimeAlert.plate}</span>
            <p>{realtimeAlert.description}</p>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{new Date(realtimeAlert.timestamp).toLocaleString()}</p>
          </div>
        </div>
      )}

      {/* Tab Navigation */}
      <div className="alerts-page__tabs">
        <button className={`alerts-page__tab ${activeTab === 'alerts' ? 'alerts-page__tab--active' : ''}`} onClick={() => setActiveTab('alerts')}>
          <AlertTriangle size={16} /> Alerts <span className="alerts-page__tab-count">{alerts.length}</span>
        </button>
        <button className={`alerts-page__tab ${activeTab === 'blacklist' ? 'alerts-page__tab--active' : ''}`} onClick={() => setActiveTab('blacklist')}>
          Blacklist <span className="alerts-page__tab-count">{blacklist.length}</span>
        </button>
        <button className={`alerts-page__tab ${activeTab === 'whitelist' ? 'alerts-page__tab--active' : ''}`} onClick={() => setActiveTab('whitelist')}>
          Whitelist <span className="alerts-page__tab-count">{whitelist.length}</span>
        </button>
      </div>

      {activeTab === 'alerts' && (
        <>
          <div className="alerts-page__filters">
            <div className="alerts-page__filter-group">
              <Filter size={16} />
              {Object.entries(severityCounts).map(([key, count]) => (
                <button key={key} className={`alerts-page__filter-btn ${filter === key ? 'alerts-page__filter-btn--active' : ''} ${key !== 'all' ? `alerts-page__filter-btn--${key}` : ''}`} onClick={() => setFilter(key)}>
                  {key.charAt(0).toUpperCase() + key.slice(1)} ({count})
                </button>
              ))}
            </div>
          </div>

          <div className="table-container">
            <table>
              <thead><tr><th>Severity</th><th>License Plate</th><th>Type</th><th>Camera</th><th>Time</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>
                {filteredAlerts.map(alert => (
                  <tr key={alert.id}>
                    <td><span className={`badge badge-${alert.severity === 'critical' ? 'danger' : alert.severity === 'warning' ? 'warning' : 'info'}`}>{alert.severity?.toUpperCase()}</span></td>
                    <td><span className="mono" style={{ color: 'var(--primary)', fontWeight: 700 }}>{alert.plate}</span></td>
                    <td style={{ fontSize: '0.8rem' }}>{alert.type}</td>
                    <td><span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem' }}><Camera size={12} style={{ color: 'var(--text-muted)' }} />{alert.camera_name || alert.camera?.name || ''}</span></td>
                    <td><span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}><Clock size={12} />{new Date(alert.timestamp).toLocaleString()}</span></td>
                    <td><span className={`badge ${alert.status === 'active' ? 'badge-warning' : 'badge-success'}`}>{alert.status === 'active' ? 'ACTIVE' : 'RESOLVED'}</span></td>
                    <td>{alert.status === 'active' ? (<button className="btn btn-sm btn-primary" onClick={() => handleResolve(alert.id)}><Check size={12} /> Resolve</button>) : <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>—</span>}</td>
                  </tr>
                ))}
                {filteredAlerts.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem' }}>No alerts yet. Waiting for watchlist matches from virtual cameras...</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {(activeTab === 'blacklist' || activeTab === 'whitelist') && (
        <div className="list-manager">
          <div className="list-manager__header">
            <h4>{activeTab === 'blacklist' ? 'Blacklisted' : 'Whitelisted'} Vehicles</h4>
            <button className="btn btn-primary btn-sm" onClick={() => setShowAddModal(true)}><Plus size={14} /> Add Vehicle</button>
          </div>
          <div className="table-container">
            <table>
              <thead><tr><th>License Plate</th><th>Reason</th><th>Added On</th><th>Added By</th><th>Action</th></tr></thead>
              <tbody>
                {(activeTab === 'blacklist' ? blacklist : whitelist).map(item => (
                  <tr key={item.id}>
                    <td><span className="mono" style={{ color: activeTab === 'blacklist' ? 'var(--danger)' : 'var(--success)', fontWeight: 700 }}>{item.plate}</span></td>
                    <td style={{ fontSize: '0.8rem' }}>{item.reason}</td>
                    <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{new Date(item.added_on).toLocaleDateString()}</td>
                    <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{item.added_by}</td>
                    <td><button className="btn btn-sm btn-danger" onClick={() => handleRemoveFromList(item.id, activeTab)}><X size={12} /> Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add Vehicle Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal__header">
              <h3>Add Vehicle to {activeTab === 'blacklist' ? 'Blacklist' : 'Whitelist'}</h3>
              <button className="btn-icon" onClick={() => setShowAddModal(false)}><X size={18} /></button>
            </div>
            <div className="modal__body">
              <div className="form-group"><label className="form-label">License Plate Number</label><input type="text" placeholder="e.g., MH-12-AB-1234" value={newPlate} onChange={e => setNewPlate(e.target.value)} /></div>
              <div className="form-group"><label className="form-label">Reason</label><input type="text" placeholder="e.g., Stolen Vehicle" value={newReason} onChange={e => setNewReason(e.target.value)} /></div>
              <div className="form-group"><label className="form-label">Added By</label><input type="text" placeholder="e.g., Police Dept" value={newAddedBy} onChange={e => setNewAddedBy(e.target.value)} /></div>
            </div>
            <div className="modal__footer">
              <button className="btn btn-secondary" onClick={() => setShowAddModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAddToList}><Plus size={14} /> Add Vehicle</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
