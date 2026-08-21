import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { logEvent } from './log.js';

const PORT = Number(process.env.PORT || 4000);

// bootstrap 打的是给人看的开服提示（建了哪个管理员之类），保持原样走 stdout。
bootstrap({ log: (line) => console.log(line) });

createApp().listen(PORT, () => {
  logEvent('server.started', { port: PORT, env: process.env.NODE_ENV || 'development' });
  console.log(`Loop IM server → http://localhost:${PORT}`);
});
