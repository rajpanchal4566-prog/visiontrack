import { useEffect, useState } from 'react';
import { Camera, Clock, Flag, ImageOff, ShieldAlert } from 'lucide-react';
import { detectionsApi } from '../../services/api';
import { onNewAlert } from '../../services/socket';
import { API_ORIGIN } from '../../services/config';
import DetectionDetailModal from '../../components/DetectionDetailModal';
import './FlaggedVehicles.css';

function imageUrl(imagePath) {
  if (!imagePath) return null;
  return /^(https?:\/\/|data:image\/)/i.test(imagePath) ? imagePath : `${API_ORIGIN}${imagePath}`;
}

function sourceLabel(item) {
  return item.violation_type || item.flag_source || 'flagged';
}

function violationLabels(item) {
  try {
    const parsed = JSON.parse(item.violations || '[]');
    if (Array.isArray(parsed) && parsed.length) return parsed.join(', ');
  } catch (error) {
    // Older detections stored a single text value instead of JSON.
  }
  return sourceLabel(item);
}

export default function FlaggedVehicles() {
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedDetectionId, setSelectedDetectionId] = useState(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    detectionsApi.getFlagged(filter ? { source: filter } : {}).then(result => {
      if (mounted) setItems(result);
    }).catch(error => console.error('Failed to load flagged vehicles:', error))
      .finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
  }, [filter]);

  useEffect(() => onNewAlert(alert => {
    if (!alert.source && alert.flag_source !== 'hardware_violation' && alert.flag_source !== 'watchlist') return;
    setItems(previous => [{
      ...alert,
      camera_name: alert.camera?.name || alert.camera_name,
      camera_city: alert.camera?.city || alert.camera_city,
      violation_type: alert.violation_type || alert.type,
      flag_source: alert.source || alert.flag_source,
      image_path: alert.image_path,
      confidence: alert.confidence,
    }, ...previous]);
  }), []);

  const tabs = [
    { label: 'All', value: '' },
    { label: 'Investigated', value: 'investigation' },
    { label: 'Hardware Violations', value: 'hardware_violation' },
    { label: 'Watchlist Matches', value: 'watchlist' },
  ];

  return (
    <div className="flagged-page animate-fade-in">
      <div className="flagged-page__intro">
        <div>
          <h2>Flagged Vehicles</h2>
          <p>Hardware-reported violations and software watchlist matches.</p>
        </div>
        <ShieldAlert size={28} />
      </div>

      <div className="flagged-page__tabs" role="tablist" aria-label="Flag source filter">
        {tabs.map(tab => (
          <button key={tab.value} type="button" className={filter === tab.value ? 'flagged-page__tab flagged-page__tab--active' : 'flagged-page__tab'} onClick={() => setFilter(tab.value)}>
            {tab.label}
          </button>
        ))}
      </div>

      {loading && <div className="flagged-page__empty">Loading flagged detections...</div>}
      {!loading && items.length === 0 && <div className="flagged-page__empty"><Flag size={24} /> No flagged detections found.</div>}
      <div className="flagged-page__grid">
        {items.map(item => {
          const image = imageUrl(item.image_path);
          return (
            <article className="flagged-card" key={`${item.id}-${item.timestamp}`} onClick={() => item.id && setSelectedDetectionId(item.id)}>
              <div className="flagged-card__header">
                <span className="flagged-card__plate mono">{item.plate}</span>
                <span className={`flagged-card__badge flagged-card__badge--${item.flag_source === 'hardware_violation' ? 'hardware' : item.flag_source === 'investigation' ? 'investigation' : 'watchlist'}`}>
                  {violationLabels(item)}
                </span>
              </div>
              <div className="flagged-card__body">
                {image ? <img src={image} alt={`Vehicle ${item.plate}`} className="flagged-card__image" /> : <div className="flagged-card__image flagged-card__image--empty"><ImageOff size={24} /></div>}
                <div className="flagged-card__details">
                  <div><Camera size={14} /><span>{item.camera_name || item.camera_id}{item.camera_city ? ` · ${item.camera_city}` : ''}</span></div>
                  <div><strong>Location</strong><span>{item.camera_zone || item.location_id || 'Location unavailable'}</span></div>
                  <div><Clock size={14} /><span>{item.timestamp ? new Date(item.timestamp).toLocaleString() : 'Time unavailable'}</span></div>
                  <div><strong>Confidence</strong><span>{item.confidence == null ? '—' : `${(Number(item.confidence) * 100).toFixed(1)}%`}</span></div>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {selectedDetectionId && <DetectionDetailModal detectionId={selectedDetectionId} onClose={() => setSelectedDetectionId(null)} />}
    </div>
  );
}