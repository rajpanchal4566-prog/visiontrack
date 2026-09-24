import { useEffect, useState } from 'react';
import { Check, Copy, Link2, Network as NetworkIcon, RefreshCw, Unlink } from 'lucide-react';
import { organizationsApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import './Network.css';

export default function Network() {
  const { user } = useAuth();
  const organizationId = user?.organization_id;
  const canEdit = ['admin', 'super_admin'].includes(user?.role);
  const [organization, setOrganization] = useState(null);
  const [organizations, setOrganizations] = useState([]);
  const [children, setChildren] = useState([]);
  const [linkKey, setLinkKey] = useState('');
  const [superadminOrgId, setSuperadminOrgId] = useState('');
  const [connectKey, setConnectKey] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);

  async function loadNetwork() {
    if (!organizationId) return;
    setLoading(true);
    try {
      const [allOrganizations, key, childOrganizations] = await Promise.all([
        organizationsApi.getAll(),
        organizationsApi.getKey(organizationId),
        organizationsApi.getChildren(organizationId),
      ]);
      const current = allOrganizations.find(item => item.id === organizationId);
      const parent = current?.parent_organization_id
        ? allOrganizations.find(item => item.id === current.parent_organization_id)
        : null;
      setOrganizations(allOrganizations);
      setOrganization({ ...current, parent });
      setLinkKey(key.link_key || '');
      setOrganization(previous => ({ ...previous, link_key: key.link_key || '' }));
      setChildren(childOrganizations);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadNetwork(); }, [organizationId]);

  async function generateLinkKey() {
    try {
      const result = await organizationsApi.generateLinkKey(organizationId);
      setLinkKey(result.link_key);
      setOrganization(previous => ({ ...previous, link_key: result.link_key }));
      setMessage('Network link key generated. Share it with the organization that will connect.');
    } catch (error) { setMessage(error.message); }
  }

  async function connect() {
    try {
      await organizationsApi.connectToSuperadmin(organizationId, { superadmin_org_id: superadminOrgId.trim(), link_key: connectKey.trim() });
      setSuperadminOrgId('');
      setConnectKey('');
      setMessage('Connected to the selected superadmin network.');
      await loadNetwork();
    } catch (error) { setMessage(error.message); }
  }

  async function disconnect() {
    try {
      await organizationsApi.disconnectSuperadmin(organizationId);
      setMessage('Disconnected from the superadmin network.');
      await loadNetwork();
    } catch (error) { setMessage(error.message); }
  }

  async function copyKey() {
    await navigator.clipboard.writeText(linkKey || '');
    setMessage('Link key copied.');
  }

  if (loading) return <div className="network-settings network-settings__empty">Loading network settings...</div>;

  return (
    <div className="network-settings animate-fade-in">
      <div className="network-settings__header">
        <div><h2>Organization Network</h2><p>Share flagged and blacklisted vehicle intelligence across linked organizations.</p></div>
        <NetworkIcon size={30} />
      </div>
      {message && <div className="network-settings__message"><Check size={15} />{message}</div>}

      <section className="network-settings__grid">
        <div className="network-settings__panel card">
          <h3>Your network link key</h3>
          <p>Generate this key when another organization should report flagged vehicles to your organization.</p>
          <div className="network-settings__key"><code>{linkKey || 'No link key generated'}</code>{linkKey && <button className="btn btn-icon" onClick={copyKey} aria-label="Copy link key"><Copy size={16} /></button>}</div>
          {canEdit && <button className="btn btn-primary" onClick={generateLinkKey}><RefreshCw size={15} /> {linkKey ? 'Regenerate link key' : 'Generate link key'}</button>}
        </div>

        <div className="network-settings__panel card">
          <h3>Connect to a superadmin</h3>
          <p>Use the link key shared by the organization you want to report to.</p>
          <label>Superadmin organization ID or name<input value={superadminOrgId} onChange={event => setSuperadminOrgId(event.target.value)} placeholder="ORG-... or organization name" /></label>
          <label>Link key<input value={connectKey} onChange={event => setConnectKey(event.target.value)} placeholder="link_..." /></label>
          {canEdit && <button className="btn btn-primary" onClick={connect} disabled={!superadminOrgId || !connectKey}><Link2 size={15} /> Connect</button>}
        </div>
      </section>

      <section className="network-settings__panel card">
        <div className="network-settings__section-header"><div><h3>Connection status</h3><p>{organization?.parent ? `Connected to: ${organization.parent.name} (${organization.parent.id})` : 'Not connected to any network'}</p></div>{organization?.parent && canEdit && <button className="btn btn-danger" onClick={disconnect}><Unlink size={15} /> Disconnect</button>}</div>
      </section>

      <section className="network-settings__panel card">
        <h3>Organizations reporting to you</h3>
        {children.length ? <div className="network-settings__children">{children.map(child => <div className="network-settings__child" key={child.id}><strong>{child.name}</strong><span className="mono">{child.id}</span><small>{child.city} · {child.status}</small></div>)}</div> : <p className="network-settings__muted">No organizations are linked under this organization.</p>}
      </section>

      <p className="network-settings__privacy">Normal traffic and analytics remain organization-scoped. Only flagged or blacklisted vehicle alerts are shared upward.</p>
      {!organizations.length && <p className="network-settings__muted">Organization directory unavailable.</p>}
    </div>
  );
}