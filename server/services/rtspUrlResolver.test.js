const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRtspUrl } = require('./rtspUrlResolver');

test('regression: rtsp://192.168.1.23:8554 input returns exactly rtsp://192.168.1.23:8554', () => {
  const input = 'rtsp://192.168.1.23:8554';
  const output = resolveRtspUrl(input);
  assert.equal(output, 'rtsp://192.168.1.23:8554');
});

test('regression: custom preset preserves exact user-entered rtsp://192.168.1.23:8554 without http:// or /video', () => {
  const input = 'rtsp://192.168.1.23:8554';
  const output = resolveRtspUrl({
    selectedPreset: 'custom',
    customUrl: input,
  });
  assert.equal(output, 'rtsp://192.168.1.23:8554');
  assert.equal(output.startsWith('http://'), false);
  assert.equal(output.endsWith('/video'), false);
});

test('regression: rtsp:// entered in IP field is passed unchanged without prepending http:// or appending /video', () => {
  const input = 'rtsp://192.168.1.23:8554';
  const output = resolveRtspUrl({
    selectedPreset: 'mobile_ipwebcam',
    ip: input,
  }, [
    { id: 'mobile_ipwebcam', template: 'http://[ip]:8080/video', port: 8080 },
  ]);
  assert.equal(output, 'rtsp://192.168.1.23:8554');
  assert.equal(output.startsWith('http://'), false);
  assert.equal(output.endsWith('/video'), false);
});

test('regression: rtsp:// stream URL with path is passed unchanged', () => {
  const input = 'rtsp://192.168.1.23:8554/stream';
  const output = resolveRtspUrl(input);
  assert.equal(output, 'rtsp://192.168.1.23:8554/stream');
});

test('regression: custom preset preserves exact user-entered HTTP URL', () => {
  const input = 'http://192.168.1.23:8080/video';
  const output = resolveRtspUrl({
    selectedPreset: 'custom',
    customUrl: input,
  });
  assert.equal(output, 'http://192.168.1.23:8080/video');
});
