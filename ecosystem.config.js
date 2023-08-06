module.exports = {
  apps: [{
    name: 'LAH-WSS',
    exec_mode: 'cluster',
    instances: 1,
    script: './server.js',
    args: 'ws',
    out_file: '../logs/wss_out.log',
    error_file: '../logs/wss_err.log',
    cron_restart: '0 7 * * *',
    time: true,
    watch: false,
    ignore_watch: ['[/\\]./', 'node_modules', '*.bat', '.git', './db/*'],
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production'
    },
    wait_ready: true,
    restart_delay: 5000
  }]
}
