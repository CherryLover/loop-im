import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { logEvent } from './log.js';
import { startOrphanSweeper } from './attachment-access.js';

const PORT = Number(process.env.PORT || 4000);

// bootstrap 打的是给人看的开服提示（建了哪个管理员之类），保持原样走 stdout。
bootstrap({ log: (line) => console.log(line) });

// 孤儿对象定期清理：Composer 在选中文件的那一刻就上传了，用户移除附件或干脆不发，
// 对象已经落库。默认每小时扫一次，删掉「超过 24 小时且没有任何消息引用」的对象。
// 挂在这里而不是 createApp 里：测试会起几百个 app 实例，不该每个都多一个定时器。
startOrphanSweeper();

createApp().listen(PORT, () => {
  logEvent('server.started', { port: PORT, env: process.env.NODE_ENV || 'development' });
  console.log(`Loop IM server → http://localhost:${PORT}`);
});
