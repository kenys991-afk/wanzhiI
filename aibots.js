// 萬王之王：AI 玩家（已清空）
// 啟停：server/aibots.sh start|stop|status
'use strict';
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const HERE=__dirname, SERVER=path.resolve(HERE,'..');

// AI 角色已清空，不再建立任何 AI 玩家
const BOTS = [];

const log=(...a)=>console.log(new Date().toLocaleString('zh-TW',{hour12:false}),...a);
log('AI 系統已停用（BOTS 為空）');

// 保留基本結構避免啟動錯誤
if(require.main === module){
  log('無 AI 角色需要啟動');
  process.exit(0);
}
