import { rmSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** 跑完删掉本次运行的临时数据目录：不给下一轮留残留，也不让 .tmp-data 越积越大。 */
export default function globalTeardown() {
  const dir = process.env.E2E_DATA_DIR_OWNED;
  if (!dir) return; // 目录由外部 E2E_DATA_DIR 指定时，交给指定的人自己收拾
  rmSync(dir, { recursive: true, force: true });
  try {
    rmdirSync(dirname(dir)); // .tmp-data 空了就一起收掉；非空说明还有别的运行在用
  } catch {
    /* 目录非空或已不存在，忽略 */
  }
}
