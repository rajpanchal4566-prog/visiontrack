import { useState, useEffect } from 'react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import ChartCard from '../../components/ChartCard';
import MapView from '../../components/MapView';
import { analyticsApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import './Analytics.css';

const COLORS = {
  sedan: '#00f0ff', suv: '#7c3aed', hatchback: '#ec4899',
  bike: '#10b981', motorcycle: '#10b981', 'two-wheeler': '#10b981',
  auto: '#f59e0b', 'auto-rickshaw': '#f59e0b', truck: '#3b82f6',
  bus: '#6366f1', van: '#f43f5e', car: '#f97316',
};

function vehicleColor(type) {
  return COLORS[String(type || '').trim().toLowerCase()] || '#a855f7';
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="analytics-tooltip">
      <p className="analytics-tooltip__label">{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color }}>
          {p.name}: <strong>{p.value?.toLocaleString()}</strong>
        </p>
      ))}
    </div>
  );
};

export default function Analytics() {
  const { user } = useAuth();
  const [trafficData, setTrafficData] = useState([]);
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [zoneTraffic, setZoneTraffic] = useState([]);
  const [congestion, setCongestion] = useState([]);
  const [heatmapData, setHeatmapData] = useState([]);
  const [timeRange, setTimeRange] = useState('today');

  useEffect(() => {
    async function fetchData() {
      try {
        const [traffic, types, zones, cong, heatmap] = await Promise.all([
          analyticsApi.getTraffic(),
          analyticsApi.getVehicleTypes(),
          analyticsApi.getZoneTraffic(),
          analyticsApi.getCongestion(),
          analyticsApi.getHeatmap(),
        ]);
        setTrafficData(traffic);
        setVehicleTypes(types);
        setZoneTraffic(zones);
        setCongestion(cong);
        setHeatmapData(heatmap);
      } catch (err) {
        console.error('Failed to fetch analytics:', err);
      }
    }
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  const congestionColors = { low: '#10b981', medium: '#f59e0b', high: '#ef4444', critical: '#dc2626' };

  return (
    <div className="analytics animate-fade-in">
      <div className="analytics__grid">
        {/* Traffic Trends */}
        <ChartCard title="Traffic Flow — Today" subtitle="Vehicle count per hour (live data)" className="analytics__traffic">
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={trafficData}>
              <defs>
                <linearGradient id="analyticsGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#00f0ff" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#00f0ff" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="bikeGrad2" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(30,41,59,0.5)" />
              <XAxis dataKey="hour" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="vehicles" stroke="#00f0ff" strokeWidth={2} fill="url(#analyticsGrad)" name="All Vehicles" />
              <Area type="monotone" dataKey="bikes" stroke="#10b981" strokeWidth={2} fill="url(#bikeGrad2)" name="Bikes" />
              <Area type="monotone" dataKey="cars" stroke="#f97316" strokeWidth={2} fill="none" name="Cars" />
              <Area type="monotone" dataKey="trucks" stroke="#3b82f6" strokeWidth={1} fill="none" name="Trucks" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Vehicle Type Distribution */}
        <ChartCard title="Vehicle Distribution" subtitle="By type (live)" className="analytics__pie">
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={vehicleTypes} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={3} dataKey="count" nameKey="type">
                {vehicleTypes.map((entry, i) => (
                  <Cell key={i} fill={entry.color || vehicleColor(entry.type)} />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
              <Legend verticalAlign="bottom" height={36} formatter={(value) => <span style={{ color: '#94a3b8', fontSize: '0.7rem' }}>{value}</span>} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Live Traffic Heatmap on Map */}
        <ChartCard title="🔥 Live Traffic Heatmap" subtitle="Camera-wise vehicle density on city map" className="analytics__heatmap">
          <MapView
            cameras={heatmapData.map(camera => ({ ...camera, id: camera.camera_id, status: camera.status || 'online' }))}
            heatmapData={heatmapData}
            showLayerToggle
            currentOrgId={user?.organization_id}
            height="350px"
          />
          <div className="analytics__congestion-legend" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#155eef' }}>Low</span>
            <span aria-label="Traffic density gradient" style={{ flex: 1, height: 8, borderRadius: 4, background: 'linear-gradient(90deg, #155eef 15%, #00f0ff 40%, #f59e0b 65%, #f97316 85%, #ef4444 100%)' }} />
            <span style={{ color: '#ef4444' }}>High</span>
          </div>
        </ChartCard>

        {/* Top Congested Areas */}
        <ChartCard title="🚧 Top Congested Areas" subtitle="Ranked by vehicle density" className="analytics__congested">
          <div className="congestion-list">
            {congestion.length === 0 && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: '1rem' }}>Building traffic data...</p>
            )}
            {congestion.map((area, i) => (
              <div key={i} className="congestion-item">
                <span className="congestion-item__rank">#{i + 1}</span>
                <div className="congestion-item__info">
                  <span className="congestion-item__name">{area.name}</span>
                  <span className="congestion-item__zone">{area.zone}</span>
                </div>
                <span className="congestion-item__count">{area.vehicle_count} vehicles</span>
                <span className={`badge badge-${area.congestion_level === 'critical' || area.congestion_level === 'high' ? 'danger' : area.congestion_level === 'medium' ? 'warning' : 'success'}`}>
                  {area.congestion_level === 'critical' ? '🔴' : area.congestion_level === 'high' ? '🔴' : area.congestion_level === 'medium' ? '🟡' : '🟢'} {area.congestion_level?.toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        </ChartCard>

        {/* Zone-wise Traffic */}
        <ChartCard title="Zone-wise Traffic" subtitle="Vehicle count by zone" className="analytics__zones">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={zoneTraffic}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(30,41,59,0.5)" />
              <XAxis dataKey="zone" stroke="#64748b" fontSize={10} />
              <YAxis stroke="#64748b" fontSize={11} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="vehicles" name="Vehicles" fill="#7c3aed" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
