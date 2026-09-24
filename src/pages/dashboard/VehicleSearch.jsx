import { useState } from 'react';
import { Search, MapPin, Clock, Eye, Shield, AlertTriangle, Car, ImageOff, Filter, Database, Calendar } from 'lucide-react';
import MapView from '../../components/MapView';
import DetectionDetailModal from '../../components/DetectionDetailModal';
import { vehiclesApi } from '../../services/api';
import { API_ORIGIN } from '../../services/config';
import { useAuth } from '../../contexts/AuthContext';
import './VehicleSearch.css';

function imageUrl(imagePath) {
  if (!imagePath) return null;
  if (/^[a-z0-9+/\s]+=*$/i.test(imagePath) && imagePath.length > 100) {
    return `data:image/jpeg;base64,${imagePath.replace(/\s/g, '')}`;
  }
  return /^(https?:\/\/|data:image\/)/i.test(imagePath) ? imagePath : `${API_ORIGIN}${imagePath}`;
}

export default function VehicleSearch() {
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selectedVehicle, setSelectedVehicle] = useState(null);
  const [trajectory, setTrajectory] = useState(null);
  const [selectedDetectionId, setSelectedDetectionId] = useState(null);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeWindow, setActiveWindow] = useState('24H');

  const handleSearch = async (e) => {
    if (e) e.preventDefault();
    const normalizedQuery = query.replace(/[^a-z0-9]/gi, '').toUpperCase();
    if (!normalizedQuery) return;
    setLoading(true);
    try {
      const found = await vehiclesApi.search(normalizedQuery);
      setResults(found);
      setSearched(true);
      if (found.length > 0) {
        await selectVehicle(found[0].plate);
      } else {
        setSelectedVehicle(null);
        setTrajectory(null);
      }
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const selectVehicle = async (plate) => {
    try {
      const traj = await vehiclesApi.getTrajectory(plate);
      setSelectedVehicle(traj);
      setTrajectory(traj.trajectory);
    } catch (err) {
      console.error('Trajectory failed:', err);
    }
  };

  return (
    <div className="forensic-explorer animate-fade-in">
      {/* 1. Subheader Telemetry Banner */}
      <div className="forensic-banner">
        <div className="forensic-banner__left">
          <div className="forensic-banner__title-row">
            <span className="forensic-banner__tag">ARCHIVE TELEMETRY</span>
            <span className="forensic-banner__pipe">/</span>
            <span className="forensic-banner__subtag">FORENSIC PLATE RETRIEVAL</span>
          </div>
          <h1 className="forensic-banner__heading">
            SEARCH & ARCHIVE EXPLORER // TRAJECTORY RECONSTRUCTION
          </h1>
          <div className="forensic-banner__meta font-mono">
            <span className="text-nominal">● REAL-TIME SQLITE BUFFER</span>
            <span>|</span>
            <span>RETENTION: 180 DAYS</span>
            <span>|</span>
            <span className="text-cyan">PARTITION: #EDGE-HYD-01</span>
          </div>
        </div>
      </div>

      {/* 2. Tactical Query Filter Toolbar */}
      <div className="tactical-filter-bar hud-bracket">
        <form onSubmit={handleSearch} className="tactical-filter-bar__form">
          {/* Plate Query Input */}
          <div className="tactical-filter-col tactical-filter-col--plate">
            <label className="tactical-filter-label font-mono">
              <Filter size={12} />
              <span>LICENSE PLATE REGEX / WILDCARD</span>
            </label>
            <div className="tactical-input-wrapper">
              <Search size={16} className="tactical-input-icon text-cyan" />
              <input
                type="text"
                className="tactical-plate-input telemetry-plate"
                placeholder="e.g. TS09EG6531 or AP10*"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              <span className="tactical-input-tag font-mono">SQL REGEXP</span>
            </div>
          </div>

          {/* Time Window Selector */}
          <div className="tactical-filter-col tactical-filter-col--window">
            <label className="tactical-filter-label font-mono">
              <Calendar size={12} />
              <span>INGEST WINDOW PRESET</span>
            </label>
            <div className="tactical-window-pills font-mono">
              {['15M', '1H', '24H', '7D', 'ALL'].map(win => (
                <button
                  key={win}
                  type="button"
                  className={`tactical-window-pill ${activeWindow === win ? 'tactical-window-pill--active' : ''}`}
                  onClick={() => setActiveWindow(win)}
                >
                  {win}
                </button>
              ))}
            </div>
          </div>

          {/* Submit Button */}
          <div className="tactical-filter-col tactical-filter-col--btn">
            <button
              type="submit"
              className="btn btn-primary tactical-search-submit hud-glow-cyan"
              disabled={loading}
            >
              <Search size={14} />
              <span>{loading ? 'RETRIEVING...' : 'EXECUTE QUERY'}</span>
            </button>
          </div>
        </form>
      </div>

      {/* Empty State */}
      {searched && results.length === 0 && (
        <div className="forensic-empty card">
          <Car size={42} className="text-outline" />
          <h3 className="font-display">NO VEHICLE TELEMETRY RECORD MATCHED</h3>
          <p className="font-mono text-outline">Query "{query}" returned 0 confirmed detections in active database partition.</p>
        </div>
      )}

      {/* Selected Vehicle Workspace */}
      {selectedVehicle && (
        <div className="forensic-workspace">
          {/* Multiple Matches Picker */}
          {results.length > 1 && (
            <div className="forensic-matches-bar font-mono">
              <span className="forensic-matches-label">MATCHED PLATES ({results.length}):</span>
              <div className="forensic-matches-list">
                {results.map((v, i) => (
                  <button
                    key={i}
                    className={`forensic-match-chip ${selectedVehicle.plate === v.plate ? 'forensic-match-chip--active' : ''}`}
                    onClick={() => selectVehicle(v.plate)}
                  >
                    <span className="telemetry-plate text-sm">{v.plate}</span>
                    <span className="text-outline text-xs">({v.total_sightings} sightings)</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Vehicle Metadata Bento Card */}
          <div className="forensic-spec-card card tactical-border-cross">
            <div className="forensic-spec-card__header">
              <div className="forensic-plate-display">
                <span className="telemetry-plate text-2xl">{selectedVehicle.plate}</span>
                {selectedVehicle.watchlist?.list_type === 'blacklist' && (
                  <span className="badge badge-danger hud-glow-amber">
                    <AlertTriangle size={11} /> HOTLIST // BLACKLISTED
                  </span>
                )}
                {selectedVehicle.watchlist?.list_type === 'whitelist' && (
                  <span className="badge badge-success">
                    <Shield size={11} /> VERIFIED // WHITELISTED
                  </span>
                )}
                <span className="badge badge-info">
                  EDGE SIGHTINGS: {selectedVehicle.total_sightings}
                </span>
              </div>
            </div>

            <div className="forensic-spec-grid font-mono">
              <div className="forensic-spec-cell">
                <span className="forensic-spec-label">VEHICLE CLASSIFICATION</span>
                <span className="forensic-spec-val text-on-surface uppercase">{selectedVehicle.vehicle_type || 'Unclassified'}</span>
              </div>
              <div className="forensic-spec-cell">
                <span className="forensic-spec-label">OPTICAL COLOR</span>
                <span className="forensic-spec-val text-on-surface uppercase">{selectedVehicle.vehicle_color || 'Unknown'}</span>
              </div>
              <div className="forensic-spec-cell">
                <span className="forensic-spec-label">FIRST CAMERA SIGHTING</span>
                <span className="forensic-spec-val text-primary">{new Date(selectedVehicle.first_seen).toLocaleString()}</span>
              </div>
              <div className="forensic-spec-cell">
                <span className="forensic-spec-label">LAST OBSERVED POINT</span>
                <span className="forensic-spec-val text-primary">{new Date(selectedVehicle.last_seen).toLocaleString()}</span>
              </div>
            </div>
          </div>

          {/* Travel Validation Alert & Speed Anomaly Table */}
          {selectedVehicle.validations?.length > 0 && (
            <div className="forensic-validation-card card">
              <div className="forensic-section-title font-display">
                <Shield size={15} className="text-cyan" />
                <span>INTER-CAMERA TRAVEL VALIDATION // SPEED ANOMALIES</span>
              </div>
              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>TRANSITION ROUTE</th>
                      <th>ACTUAL TRANSIT</th>
                      <th>EXPECTED MINIMUM</th>
                      <th>CALCULATED SPEED</th>
                      <th>VERIFICATION STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedVehicle.validations.map(val => (
                      <tr key={val.id}>
                        <td className="font-mono text-cyan font-bold">{val.first_camera_id} → {val.second_camera_id}</td>
                        <td className="font-mono">{Math.round(val.elapsed_time_seconds / 60)} min</td>
                        <td className="font-mono text-outline">{val.expected_travel_time_seconds ? `${Math.round(val.expected_travel_time_seconds / 60)} min` : 'N/A'}</td>
                        <td className="font-mono font-bold text-on-surface">{val.calculated_speed_kmh ? `${val.calculated_speed_kmh} km/h` : '—'}</td>
                        <td>
                          <span className={`badge ${val.status === 'NORMAL' ? 'badge-success' : val.status === 'OVERSPEED' || val.status === 'SPEEDING' ? 'badge-warning' : 'badge-danger'}`}>
                            {val.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* GIS Trajectory Reconstruction Map */}
          <div className="forensic-map-card card tactical-border-cross">
            <div className="forensic-section-title font-display">
              <MapPin size={16} className="text-cyan" />
              <span>VEHICLE TRAJECTORY // GIS ROUTE RECONSTRUCTION</span>
            </div>
            {trajectory && trajectory.length > 0 ? (
              <MapView
                cameras={[]}
                trajectory={trajectory}
                showEntryExit
                currentOrgId={user?.organization_id}
                height="440px"
              />
            ) : (
              <div className="forensic-no-map font-mono text-outline">No coordinates available for polyline route mapping.</div>
            )}
          </div>

          {/* Chronological Detection Timeline */}
          <div className="forensic-timeline-card card">
            <div className="forensic-section-title font-display">
              <Clock size={16} className="text-cyan" />
              <span>CHRONOLOGICAL DETECTION TIMELINE ({selectedVehicle.total_sightings} SIGHTINGS)</span>
            </div>
            <div className="timeline">
              {(trajectory || []).map((point, i) => (
                <div key={i} className="timeline__item">
                  <div className="timeline__dot">
                    <div className="timeline__dot-inner"></div>
                  </div>
                  {i < (trajectory?.length || 0) - 1 && <div className="timeline__line"></div>}
                  <div className="timeline__content tactical-timeline-box">
                    <div className="timeline__camera">
                      <Eye size={14} className="text-cyan" />
                      <strong className="font-display text-primary">{point.camera_name}</strong>
                    </div>
                    <div className="timeline__meta font-mono">
                      <span><Clock size={12} /> {new Date(point.timestamp).toLocaleString()}</span>
                      {point.camera_city && <span><MapPin size={12} /> {point.camera_city}</span>}
                      <span><MapPin size={12} /> {point.zone}</span>
                      <span className="badge badge-info">{i === 0 ? 'ENTRY [IN]' : i === trajectory.length - 1 ? 'EXIT [OUT]' : `WAYPOINT ${i + 1}`}</span>
                      <span className="badge badge-success">{(point.confidence * 100).toFixed(0)}% CONF</span>
                      {point.speed && <span className="font-mono text-primary font-bold">{point.speed} km/h</span>}
                    </div>
                    <div
                      className="timeline__image tactical-image-stamp"
                      onClick={() => point.id && setSelectedDetectionId(point.id)}
                      onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && point.id && setSelectedDetectionId(point.id)}
                      role={point.id ? 'button' : undefined}
                      tabIndex={point.id ? 0 : undefined}
                      title="Inspect full frame detection details"
                    >
                      {imageUrl(point.image_path) ? (
                        <img src={imageUrl(point.image_path)} alt={`Plate ${selectedVehicle.plate} at ${point.camera_name}`} />
                      ) : (
                        <span><ImageOff size={13} /> NO STAMP</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Modal for full inspection */}
          {selectedDetectionId && (
            <DetectionDetailModal
              detectionId={selectedDetectionId}
              onClose={() => setSelectedDetectionId(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
