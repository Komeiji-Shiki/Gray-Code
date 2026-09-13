import { VelopackApp } from 'velopack';

// 安装钩子必须先于 Electron、数据库和后台服务；应用更新始终由用户确认。
VelopackApp.build().setAutoApplyOnStartup(false).run();
require('./main');
