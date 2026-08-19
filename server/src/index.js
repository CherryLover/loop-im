import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';

const PORT = Number(process.env.PORT || 4000);

bootstrap({ log: (line) => console.log(line) });

createApp().listen(PORT, () => console.log(`Loop IM server → http://localhost:${PORT}`));
