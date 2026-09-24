// ============================================
// VisionTrack — Socket.IO Client
// Real-time connection to the VisionTrack platform
// ============================================
import { io } from 'socket.io-client';
import { API_ORIGIN } from './config';

const SOCKET_URL = API_ORIGIN;

let socket = null;

export function getSocket() {
  if (!socket) {
    socket = io(SOCKET_URL, {
      autoConnect: true,
      auth: { token: localStorage.getItem('anpr_token') },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
    });

    socket.on('connect', () => {
      console.log('🔌 Connected to VisionTrack');
    });

    socket.on('disconnect', () => {
      console.log('🔌 Disconnected from VisionTrack');
    });

    socket.on('connect_error', (err) => {
      console.warn('⚠️ Socket connection error:', err.message);
    });
  }
  return socket;
}

// --- Event Listeners ---
export function onNewDetection(callback) {
  const s = getSocket();
  s.on('detection:new', callback);
  return () => s.off('detection:new', callback);
}

export function onNewAlert(callback) {
  const s = getSocket();
  s.on('alert:new', callback);
  return () => s.off('alert:new', callback);
}

export function onTrafficUpdate(callback) {
  const s = getSocket();
  s.on('traffic:update', callback);
  return () => s.off('traffic:update', callback);
}

export function onCameraStatus(callback) {
  const s = getSocket();
  s.on('camera:status', callback);
  return () => s.off('camera:status', callback);
}

export function onStreamFrame(callback) {
  const s = getSocket();
  s.on('stream:frame', callback);
  return () => s.off('stream:frame', callback);
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
