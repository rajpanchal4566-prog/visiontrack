import { useState, useEffect } from 'react';
import { Camera, AlertTriangle, Gauge, Activity, Route } from 'lucide-react';
import StatCard from '../../components/StatCard';
import ChartCard from '../../components/ChartCard';
import DetectionFeed from '../../components/DetectionFeed';
import MapView from '../../components/MapView';
import { detectionsApi, alertsApi, camerasApi, travelApi, analyticsApi } from '../../services/api';
import { onNewDetection, onNewAlert } from '../../services/socket';
import { useAuth } from '../../contexts/AuthContext';
import './Overview.css';

export default function Overview() {
  const { user } = useAuth();
  const [detections, setDetections] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [stats, setStats] = useState({ totalToday: 0, avgConfidence: 0 });
  const [alertStats, setAlertStats] = useState({ today: 0, active: 0 });
  const [loading, setLoading] = useState(true);
  const [validations, setValidations] = useState([]);
  const [flagged, setFlagged] = useState([]);
  const [dayOverDay, setDayOverDay] = useState(null);

  // Fetch initial data
  useEffect(() => {
    async function fetchData() {
      try {
        const [dets, cams, detStats, altStats, alts, validationRows, flaggedRows, comparison] = await Promise.all([
          detectionsApi.getLatest(15),
          camerasApi.getAll(),
          detectionsApi.getStats(),
          alertsApi.getStats(),
          alertsApi.getAll({ limit: 5 }),
          travelApi.getValidations({ limit: 8 }),
          travelApi.getFlaggedVehicles({ limit: 1 }),
          analyticsApi.getDayOverDay(),
        ]);
        setDetections(dets);
        setCameras(cams);
        setStats(detStats);
        setAlertStats(altStats);
        setAlerts(alts);
        setValidations(validationRows);
        setFlagged(flaggedRows);
        setDayOverDay(comparison);
      } catch (err) {
        console.error('Failed to fetch overview data:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  // Real-time: new detections via WebSocket
  useEffect(() => {
    const unsub = onNewDetection((detection) => {
      setDetections(prev => [detection, ...prev.slice(0, 14)]);
      setStats(prev => ({ ...prev, totalToday: prev.totalToday + 1 }));
    });
    return unsub;
  }, []);

  // Real-time: new alerts via WebSocket
  useEffect(() => {
    const unsub = onNewAlert((alert) => {
      setAlerts(prev => [alert, ...prev.slice(0, 4)]);
      setAlertStats(prev => ({ ...prev, today: prev.today + 1, active: prev.active + 1 }));
    });
    return unsub;
  }, []);

  const onlineCameras = cameras.filter(c => c.status === 'online').length;
  const networkCities = [...new Set(cameras.map(camera => camera.city).filter(Boolean))];
  const getDelta = (value, change) => {
    if (change === null || change === undefined) return { text: 'New today', trend: 'neutral' };
    if (change === 0) return { text: 'No change', trend: 'neutral' };
    return { text: `${change > 0 ? '+' : ''}${change.toFixed(0)}% vs yesterday`, trend: change > 0 ? 'up' : 'down' };
  };
  const detectionsDelta = dayOverDay && getDelta(dayOverDay.today.totalDetections, dayOverDay.percentChangeDetections);
  const flaggedDelta = dayOverDay && getDelta(dayOverDay.today.totalFlagged, dayOverDay.percentChangeFlagged);
  const detectionSparkline = dayOverDay?.last7Days.map(day => ({ value: day.totalDetections }));
  const flaggedSparkline = dayOverDay?.last7Days.map(day => ({ value: day.totalFlagged }));

  return (
    <div className="overview animate-fade-in">
      {/* Stat Cards */}
      <div className="overview__stats stagger-children">
        <StatCard
          icon={Activity}
          label="Total Detections Today"
          value={stats.totalToday.toLocaleString()}
          trend="up"
          trendValue="Live"
          deltaText={detectionsDelta?.text}
          deltaTrend={detectionsDelta?.trend}
          sparklineData={detectionSparkline}
          sparklineColor="#3b82f6"
          color="primary"
        />
        <StatCard icon={Camera} label="Registered Cameras" value={cameras.length} trend="neutral" trendValue="GPS active" color="secondary" />
        <StatCard
          icon={Camera}
          label="Connected Cameras"
          value={`${onlineCameras} / ${cameras.length}`}
          trend="neutral"
          trendValue="Online"
          color="success"
        />
        <StatCard
          icon={AlertTriangle}
          label="Alerts Today"
          value={alertStats.today}
          trend={alertStats.active > 0 ? 'up' : 'neutral'}
          trendValue={`${alertStats.active} active`}
          deltaText={flaggedDelta?.text}
          deltaTrend={flaggedDelta?.trend}
          sparklineData={flaggedSparkline}
          sparklineColor="#f59e0b"
          color="warning"
        />
        <StatCard
          icon={Gauge}
          label="Avg. Confidence"
          value={`${(stats.avgConfidence * 100).toFixed(1)}%`}
          trend="up"
          trendValue=">90%"
          color="info"
        />
        <StatCard icon={Route} label="Tracked Vehicles" value={(stats.uniqueVehiclesToday ?? new Set(detections.map(item => item.plate)).size).toLocaleString()} trend="up" trendValue="Unique today" color="secondary" />
        <StatCard icon={Gauge} label="Speeding Events" value={validations.filter(item => item.status === 'SPEEDING').length} trend="up" trendValue="Review" color="warning" />
        <StatCard icon={AlertTriangle} label="Suspicious Travel" value={validations.filter(item => item.status === 'SUSPICIOUS TRAVEL').length} trend="up" trendValue="Review" color="danger" />
        <StatCard icon={AlertTriangle} label="Flagged Vehicles" value={dayOverDay?.today.totalFlagged ?? flagged.length} trend={dayOverDay?.today.totalFlagged ? 'up' : 'neutral'} trendValue="Review queue" deltaText={flaggedDelta?.text} deltaTrend={flaggedDelta?.trend} sparklineData={flaggedSparkline} sparklineColor="#ef4444" color="danger" />
      </div>

      <div className="overview__grid">
        {/* Live Detection Feed */}
        <ChartCard title="Live Detection Feed" className="overview__feed">
          <DetectionFeed detections={detections} />
        </ChartCard>

        {/* City Map */}
        <ChartCard title={`Camera Network — ${networkCities.length} ${networkCities.length === 1 ? 'city' : 'cities'}`} subtitle="Real-time camera status" className="overview__map">
          <MapView cameras={cameras} currentOrgId={user?.organization_id} height="350px" />
        </ChartCard>

        {/* Recent Alerts */}
        <ChartCard title="Recent Alerts" className="overview__alerts">
          <div className="overview__alert-list">
            {alerts.length === 0 && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: '2rem' }}>
                No alerts yet. Waiting for watchlist matches...
              </p>
            )}
            {alerts.map((alert, i) => (
              <div key={alert.id || i} className={`overview__alert-item overview__alert-item--${alert.severity}`}>
                <div className="overview__alert-top">
                  <span className={`badge badge-${alert.severity === 'critical' ? 'danger' : alert.severity === 'warning' ? 'warning' : 'info'}`}>
                    {alert.severity?.toUpperCase()}
                  </span>
                  <span className="overview__alert-type">{alert.type}</span>
                </div>
                <div className="overview__alert-plate mono">{alert.plate}</div>
                <div className="overview__alert-meta">
                  <span>{alert.camera?.name || alert.camera_name || ''}</span>
                  <span>{new Date(alert.timestamp).toLocaleTimeString()}</span>
                </div>
              </div>
            ))}
          </div>
        </ChartCard>

        <ChartCard title="Camera Travel Validation" subtitle="Latest reconstructed transitions" className="overview__validation">
          <div className="overview__validation-table table-container">
            <table>
              <thead><tr><th>From</th><th>To</th><th>Distance</th><th>Expected</th><th>Actual</th><th>Speed / Limit</th><th>Status / Reason</th></tr></thead>
              <tbody>
                {validations.map(item => (
                  <tr key={item.id}>
                    <td><strong>{item.first_camera_name || item.first_camera_id}</strong><small>{item.first_camera_zone || item.first_camera_id}<br />{item.first_detection_time ? new Date(item.first_detection_time).toLocaleString() : 'Time unavailable'}</small></td>
                    <td><strong>{item.second_camera_name || item.second_camera_id}</strong><small>{item.second_camera_zone || item.second_camera_id}<br />{item.second_detection_time ? new Date(item.second_detection_time).toLocaleString() : 'Time unavailable'}</small></td>
                    <td>{item.distance_km ?? '—'} km<small>{item.route_source || item.distance_source || 'Route unavailable'}</small></td>
                    <td>{item.expected_travel_time_seconds ? `${Math.round(item.expected_travel_time_seconds / 60)} min` : '—'}</td>
                    <td>{item.elapsed_time_seconds > 0 ? `${Math.round(item.elapsed_time_seconds / 60)} min` : '—'}</td>
                    <td>{item.calculated_speed_kmh ?? '—'} / {item.speed_threshold_kmh ?? item.speed_limit_kmh ?? '—'} km/h</td>
                    <td><span className={`badge ${item.status === 'NORMAL' ? 'badge-success' : item.status === 'SPEEDING' ? 'badge-warning' : 'badge-danger'}`}>{item.status}</span><small>{item.reason || 'Within expected travel limits'}</small></td>
                  </tr>
                ))}
                {!validations.length && <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '1.5rem' }}>Waiting for multi-camera transitions.</td></tr>}
              </tbody>
            </table>
          </div>
          {flagged.length > 0 && <p className="overview__flagged-note">Flagged vehicle review queue has new records.</p>}
        </ChartCard>
      </div>
    </div>
  );
}
