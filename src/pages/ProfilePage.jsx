import { useState } from 'react';
import { Copy, KeyRound, User, Wifi } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import './ProfilePage.css';

export default function ProfilePage() {
  const { user, connection } = useAuth();
  const [copied, setCopied] = useState('');

  async function copyValue(label, value) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(''), 1600);
  }

  const details = [
    ['API Gateway Key', connection?.api_key],
    ['Server URL', connection?.server_url],
    ['Ingest Endpoint', connection?.ingest_endpoint],
    ['Full Ingest URL', connection?.ingest_url],
  ];

  return (
    <div className="profile-page animate-fade-in">
      <section className="profile-page__identity card">
        <div className="profile-page__avatar"><User size={26} /></div>
        <div>
          <h3>{user?.name}</h3>
          <p>{user?.email}</p>
          <span className="badge badge-success">{user?.role?.replace('_', ' ')}</span>
        </div>
        <div className="profile-page__organization">
          <strong>{user?.organization_name}</strong>
          <span>{user?.organization_city}</span>
        </div>
      </section>

      <section className="profile-page__connection card">
        <h3><Wifi size={18} /> External Camera Connection</h3>
        <p>Use these organization credentials in the outside virtual camera configuration.</p>
        <div className="profile-page__details">
          {details.map(([label, value]) => (
            <div className="profile-page__detail" key={label}>
              <span>{label}</span>
              <code>{value || 'Unavailable'}</code>
              {value && (
                <button className="btn btn-icon" type="button" onClick={() => copyValue(label, value)} aria-label={`Copy ${label}`}>
                  <Copy size={16} />
                </button>
              )}
              {copied === label && <small>Copied</small>}
            </div>
          ))}
        </div>
        <div className="profile-page__notice"><KeyRound size={16} /> The API gateway key is shared by cameras registered to this organization.</div>
      </section>
    </div>
  );
}
