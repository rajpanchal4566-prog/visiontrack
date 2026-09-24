import './ChartCard.css';

export default function ChartCard({ title, subtitle, action, children, className = '' }) {
  return (
    <div className={`chart-card ${className}`}>
      <div className="chart-card__header">
        <div>
          <h4 className="chart-card__title">{title}</h4>
          {subtitle && <p className="chart-card__subtitle">{subtitle}</p>}
        </div>
        {action && <div className="chart-card__action">{action}</div>}
      </div>
      <div className="chart-card__body">
        {children}
      </div>
    </div>
  );
}
