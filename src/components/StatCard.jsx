import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line } from 'recharts';
import './StatCard.css';

export default function StatCard({ icon: Icon, label, value, trend, trendValue, deltaText, deltaTrend = 'neutral', sparklineData, sparklineColor, color = 'primary' }) {
  const TrendIcon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus;
  const trendClass = trend === 'up' ? 'trend--up' : trend === 'down' ? 'trend--down' : 'trend--neutral';

  return (
    <div className={`stat-card stat-card--${color}`}>
      <div className="stat-card__header">
        <div className={`stat-card__icon stat-card__icon--${color}`}>
          <Icon size={22} />
        </div>
        {trendValue && (
          <div className={`stat-card__trend ${trendClass}`}>
            <TrendIcon size={14} />
            <span>{trendValue}</span>
          </div>
        )}
      </div>
      <div className="stat-card__value">{value}</div>
      <div className="stat-card__label">{label}</div>
      {deltaText && <div className={`stat-card__delta stat-card__delta--${deltaTrend}`}>{deltaText}</div>}
      {sparklineData?.length > 1 && (
        <div className="stat-card__sparkline">
          <ResponsiveContainer width="100%" height={48}>
            <LineChart data={sparklineData}>
              <Line type="monotone" dataKey="value" stroke={sparklineColor || 'var(--primary)'} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className={`stat-card__glow stat-card__glow--${color}`}></div>
    </div>
  );
}
