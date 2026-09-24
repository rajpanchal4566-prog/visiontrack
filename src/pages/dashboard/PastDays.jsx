import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, CalendarDays } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import ChartCard from '../../components/ChartCard';
import MapView from '../../components/MapView';
import StatCard from '../../components/StatCard';
import { analyticsApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import './PastDays.css';

function todayString() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function confidenceLabel(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

export default function PastDays() {
  const { user } = useAuth();
  const [date, setDate] = useState(() => todayString());
  const [summary, setSummary] = useState(null);
  const [traffic, setTraffic] = useState([]);
  const [heatmap, setHeatmap] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const syncToToday = () => {
      const currentDay = todayString();
      setDate(previous => (previous === currentDay ? previous : currentDay));
    };

    syncToToday();
    const timer = setInterval(syncToToday, 60000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let mounted = true;
    let firstLoad = true;

    const fetchData = async () => {
      if (firstLoad) setLoading(true);
      setError('');
      try {
        const [daySummary, trafficRows, heatmapRows] = await Promise.all([
          analyticsApi.getDaySummary(date),
          analyticsApi.getTraffic(date),
          analyticsApi.getHeatmap(date),
        ]);
        if (!mounted) return;
        setSummary(daySummary);
        setTraffic(trafficRows);
        setHeatmap(heatmapRows);
      } catch (err) {
        if (mounted) setError(err.message || 'Unable to load historical analytics.');
      } finally {
        if (mounted && firstLoad) {
          firstLoad = false;
          setLoading(false);
        }
      }
    };

    fetchData();
    const refreshTimer = setInterval(fetchData, 5000);
    return () => {
      mounted = false;
      clearInterval(refreshTimer);
    };
  }, [date]);

  const mapCameras = heatmap.map(camera => ({
    ...camera,
    id: camera.camera_id,
    status: camera.status || 'online',
  }));

  return (
    <div className="past-days animate-fade-in">
      <div className="past-days__header">
        <div>
          <span className="past-days__eyebrow">Historical analytics</span>
          <h2>Past Days</h2>
          <p>Review detection activity and traffic patterns for a selected day.</p>
        </div>
        <label className="past-days__date">
          <CalendarDays size={17} />
          <span>Date</span>
          <input
            type="date"
            value={date}
            max={todayString()}
            onClick={event => event.currentTarget.showPicker?.()}
            onChange={event => event.target.value && setDate(event.target.value)}
          />
          <button type="button" className="past-days__today" onClick={() => setDate(todayString())} disabled={date === todayString()}>
            Today
          </button>
        </label>
      </div>

      {loading && <div className="past-days__state">Loading analytics for {date}...</div>}
      {!loading && error && <div className="past-days__state past-days__state--error">{error}</div>}
      {!loading && !error && summary && summary.totalDetections === 0 && (
        <div className="past-days__state"><Activity size={22} /> No detections were recorded on {date}.</div>
      )}
      {!loading && !error && summary && summary.totalDetections > 0 && (
        <>
          <div className="past-days__stats">
            <StatCard icon={Activity} label="Total Detections" value={summary.totalDetections.toLocaleString()} trend="neutral" trendValue={date} color="primary" />
            <StatCard icon={AlertTriangle} label="Total Flagged" value={summary.totalFlagged.toLocaleString()} trend={summary.totalFlagged ? 'up' : 'neutral'} trendValue="Recorded flags" color="danger" />
            <StatCard icon={Activity} label="Average Confidence" value={confidenceLabel(summary.avgConfidence)} trend="neutral" trendValue="Daily average" color="info" />
          </div>

          <div className="past-days__grid">
            <ChartCard title={`Traffic Flow — ${date}`} subtitle="Vehicle count per hour" className="past-days__traffic">
              <ResponsiveContainer width="100%" height={310}>
                <AreaChart data={traffic}>
                  <defs>
                    <linearGradient id="pastDaysTrafficGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#00f0ff" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#00f0ff" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(30,41,59,0.5)" />
                  <XAxis dataKey="hour" stroke="#64748b" fontSize={11} />
                  <YAxis stroke="#64748b" fontSize={11} />
                  <Tooltip />
                  <Area type="monotone" dataKey="vehicles" stroke="#00f0ff" strokeWidth={2} fill="url(#pastDaysTrafficGradient)" name="All Vehicles" />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title={`Traffic Heatmap — ${date}`} subtitle="Camera-wise daily vehicle density" className="past-days__map">
              <MapView cameras={mapCameras} heatmapData={heatmap} showLayerToggle currentOrgId={user?.organization_id} height="350px" />
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}
