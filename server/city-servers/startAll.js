// ============================================
// VisionTrack — Launch All City Servers
// Starts Indore (3101), Pune (3102), Bhopal (3103)
// ============================================
const { spawn } = require('child_process');
const path = require('path');

const cityServerPath = path.join(__dirname, 'cityServer.js');

const servers = [
  { id: 'SRV-INDORE', name: 'Indore', port: 3101 },
  { id: 'SRV-PUNE', name: 'Pune', port: 3102 },
  { id: 'SRV-BHOPAL', name: 'Bhopal', port: 3103 },
];

console.log('🚀 Starting all city traffic servers...\n');

const processes = [];

for (const srv of servers) {
  const proc = spawn('node', [cityServerPath, srv.id], {
    stdio: 'inherit',
    env: { ...process.env },
  });

  proc.on('error', (err) => {
    console.error(`❌ Failed to start ${srv.name}: ${err.message}`);
  });

  proc.on('exit', (code) => {
    console.log(`🔴 ${srv.name} server exited with code ${code}`);
  });

  processes.push(proc);
}

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down all city servers...');
  processes.forEach(p => p.kill());
  process.exit(0);
});

process.on('SIGTERM', () => {
  processes.forEach(p => p.kill());
  process.exit(0);
});
