import { VelopackApp } from 'velopack';

// 安装钩子必须先于 Electron、数据库和后台服务；应用更新始终由用户确认。
VelopackApp.build().setAutoApplyOnStartup(false).run();

// 第二次点击只负责唤醒已有窗口，不加载平台服务和它们的原生依赖。
const { app } = require('electron') as typeof import('electron');
app.setName('GrayCode');
if (app.requestSingleInstanceLock()) require('./runtime.cjs');
else app.quit();
