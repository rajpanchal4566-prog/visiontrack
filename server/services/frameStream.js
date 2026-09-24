const { spawn } = require('child_process');

function extractJpegs(buffer, onFrame) {
  let pending = buffer;
  while (true) {
    const start = pending.indexOf(Buffer.from([0xff, 0xd8]));
    if (start < 0) {
      if (pending.length > 2) pending = pending.slice(-2);
      break;
    }
    const end = pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) {
      pending = pending.slice(start);
      break;
    }
    onFrame(pending.slice(start, end + 2));
    pending = pending.slice(end + 2);
  }
  return pending;
}

function spawnFrameProcess(input, options = {}) {
  const defaultFps = Number(process.env.FRAME_SAMPLE_FPS || process.env.ANPR_SAMPLE_FPS || process.env.VIDEO_SAMPLE_FPS) || 16;
  const fps = Math.max(0.1, Math.min(30.0, Number(options.fps || defaultFps)));
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', input,
    '-vf', `fps=${fps},scale='if(gt(iw,1920),1920,iw)':-2`,
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-q:v', '3',
    'pipe:1',
  ];
  const child = spawn(options.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg', args, { windowsHide: true });
  let pending = Buffer.alloc(0);
  child.stdout.on('data', chunk => {
    pending = extractJpegs(Buffer.concat([pending, chunk]), frame => options.onFrame(frame));
  });
  return child;
}

module.exports = { extractJpegs, spawnFrameProcess };
