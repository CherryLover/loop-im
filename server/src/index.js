import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { logError, logEvent, logWarn } from './log.js';
import { startOrphanSweeper } from './attachment-access.js';
import { ensureStoreReady, getDriver } from './storage.js';

const PORT = Number(process.env.PORT || 4000);

// bootstrap 打的是给人看的开服提示（建了哪个管理员之类），保持原样走 stdout。
bootstrap({ log: (line) => console.log(line) });

/**
 * 对外服务之前先把附件存储准备好：连上对象存储、桶不在就建、再跑一个读写来回。
 *
 * 为什么挡在 listen 之前：compose 一起来就该是「全部就绪」，不该出现容器 Up、
 * 聊天能用、只有发图坏的半开状态 —— 那种问题往往要等用户来报才发现。
 * 自检失败就退出，交给 compose 的 restart 策略重来；`docker compose ps` 里
 * 会明明白白显示 Restarting，比一个假装健康的容器好查得多。
 *
 * 本地磁盘驱动（没配 S3_BUCKET）走的是同一条路，只是自检内容退化成建目录。
 */
const store = await ensureStoreReady({
  log: ({ attempt, attempts, message }) =>
    logWarn('store.not-ready', { attempt, attempts, driver: getDriver(), message }),
}).catch((err) => {
  logError('store.unavailable', err, { driver: getDriver() });
  console.error('附件存储没能就绪，服务不启动。检查 MinIO 容器与 .env 里的 S3_* 配置。');
  process.exit(1);
});

logEvent('store.ready', store);
if (store.created) console.log(`已自动创建对象存储桶：${store.detail}`);

// 孤儿对象定期清理：Composer 在选中文件的那一刻就上传了，用户移除附件或干脆不发，
// 对象已经落库。**这套清理默认不开** —— 它会真的删用户传上来的文件，而本项目的取向是
// 程序层面不主动删数据，桶涨多大交给运维侧的转存 / 备份去管。要开就显式设
// UPLOAD_ORPHAN_SWEEP=on，开了之后每小时扫一次，删「超过 24 小时且没有任何消息引用」的对象。
// 挂在这里而不是 createApp 里：测试会起几百个 app 实例，不该每个都多一个定时器。
startOrphanSweeper();

createApp().listen(PORT, () => {
  logEvent('server.started', { port: PORT, env: process.env.NODE_ENV || 'development' });
  console.log(`Loop IM server → http://localhost:${PORT}`);
});
