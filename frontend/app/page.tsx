'use client';

import { useEffect, useState, useCallback } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface EventRow {
  id: number;
  event_id: string;
  type: string;
  data: any;
  status: string;
  attempt_count: number;
  max_attempts: number;
  locked_by: string | null;
  created_at: string;
  updated_at: string;
  has_processed_order: string;
}

interface Attempt {
  id: number;
  event_id: string;
  attempt_number: number;
  worker_id: string;
  started_at: string;
  finished_at: string;
  result: string;
  error: string | null;
}

interface Stats {
  total: string;
  pending: string;
  processing: string;
  completed: string;
  failed: string;
  processedOrders: number;
}

export default function OperationsPage() {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [eventsRes, statsRes] = await Promise.all([
        fetch(`${API_URL}/api/events`),
        fetch(`${API_URL}/api/stats`),
      ]);
      setEvents(await eventsRes.json());
      setStats(await statsRes.json());
    } catch (err) {
      console.error('Failed to fetch data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 2000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const fetchAttempts = async (eventId: string) => {
    setSelectedEvent(eventId);
    try {
      const res = await fetch(`${API_URL}/api/events/${eventId}`);
      const data = await res.json();
      setAttempts(data.attempts || []);
    } catch (err) {
      console.error('Failed to fetch attempts:', err);
    }
  };

  const manualRetry = async (eventId: string) => {
    try {
      await fetch(`${API_URL}/api/events/${eventId}/retry`, { method: 'POST' });
      fetchData();
    } catch (err) {
      console.error('Failed to retry:', err);
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'completed': return '#22c55e';
      case 'failed': return '#ef4444';
      case 'processing': return '#f59e0b';
      case 'pending': return '#3b82f6';
      default: return '#6b7280';
    }
  };

  if (loading) return <div>Loading...</div>;

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <h1>Webhook Processor — Operations</h1>

      {stats && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
          {[
            { label: 'Total', value: stats.total, color: '#6b7280' },
            { label: 'Pending', value: stats.pending, color: '#3b82f6' },
            { label: 'Processing', value: stats.processing, color: '#f59e0b' },
            { label: 'Completed', value: stats.completed, color: '#22c55e' },
            { label: 'Failed', value: stats.failed, color: '#ef4444' },
            { label: 'Processed Orders', value: stats.processedOrders, color: '#8b5cf6' },
          ].map((s) => (
            <div key={s.label} style={{
              background: 'white', padding: '12px 20px', borderRadius: 8,
              borderLeft: `4px solid ${s.color}`, minWidth: 120,
            }}>
              <div style={{ fontSize: 24, fontWeight: 'bold' }}>{s.value}</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      <h2>Events</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: 'white', borderRadius: 8 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
            <th style={thStyle}>Event ID</th>
            <th style={thStyle}>Type</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Attempts</th>
            <th style={thStyle}>Worker</th>
            <th style={thStyle}>Created</th>
            <th style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
              <td style={tdStyle}>
                <a href="#" onClick={(ev) => { ev.preventDefault(); fetchAttempts(e.event_id); }}
                   style={{ color: '#3b82f6', textDecoration: 'none' }}>
                  {e.event_id}
                </a>
              </td>
              <td style={tdStyle}>{e.type}</td>
              <td style={tdStyle}>
                <span style={{
                  background: statusColor(e.status), color: 'white',
                  padding: '2px 8px', borderRadius: 4, fontSize: 12,
                }}>{e.status}</span>
              </td>
              <td style={tdStyle}>{e.attempt_count} / {e.max_attempts}</td>
              <td style={tdStyle}>{e.locked_by || '—'}</td>
              <td style={tdStyle}>{new Date(e.created_at).toLocaleString()}</td>
              <td style={tdStyle}>
                {e.status === 'failed' && (
                  <button onClick={() => manualRetry(e.event_id)}
                    style={{ background: '#3b82f6', color: 'white', border: 'none', padding: '4px 12px', borderRadius: 4, cursor: 'pointer' }}>
                    Retry
                  </button>
                )}
              </td>
            </tr>
          ))}
          {events.length === 0 && (
            <tr><td colSpan={7} style={{ ...tdStyle, textAlign: 'center', color: '#6b7280' }}>No events yet</td></tr>
          )}
        </tbody>
      </table>

      {selectedEvent && (
        <div style={{ marginTop: 24 }}>
          <h2>Attempt History — {selectedEvent}</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: 'white', borderRadius: 8 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
                <th style={thStyle}>#</th>
                <th style={thStyle}>Worker</th>
                <th style={thStyle}>Started</th>
                <th style={thStyle}>Finished</th>
                <th style={thStyle}>Result</th>
                <th style={thStyle}>Error</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                  <td style={tdStyle}>{a.attempt_number}</td>
                  <td style={tdStyle}>{a.worker_id}</td>
                  <td style={tdStyle}>{new Date(a.started_at).toLocaleString()}</td>
                  <td style={tdStyle}>{a.finished_at ? new Date(a.finished_at).toLocaleString() : '—'}</td>
                  <td style={tdStyle}>
                    <span style={{
                      color: a.result === 'success' ? '#22c55e' : '#ef4444', fontWeight: 'bold',
                    }}>{a.result}</span>
                  </td>
                  <td style={{ ...tdStyle, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {a.error || '—'}
                  </td>
                </tr>
              ))}
              {attempts.length === 0 && (
                <tr><td colSpan={6} style={{ ...tdStyle, textAlign: 'center', color: '#6b7280' }}>No attempts yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: '10px 12px', fontSize: 13, color: '#374151' };
const tdStyle: React.CSSProperties = { padding: '8px 12px', fontSize: 13 };
