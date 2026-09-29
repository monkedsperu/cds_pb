// pm2 mantiene el servidor siempre encendido: lo reinicia si se cae y lo arranca al prender la máquina.
// Uso (una sola vez, en el servidor):
//   npm install -g pm2
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 startup        (muestra un comando: cópialo y ejecútalo para que arranque con la máquina)
// Día a día: pm2 status · pm2 logs monitor-buses · pm2 restart monitor-buses (tras copiar una versión nueva)
module.exports = {
  apps: [{
    name: 'monitor-buses',
    script: 'server.js',
    cwd: __dirname,
    autorestart: true,
    max_restarts: 50,
    restart_delay: 5000,
    max_memory_restart: '600M',
    env: { NODE_ENV: 'production' },
  }],
};
