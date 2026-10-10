# 萬王之王 Online 伺服器

- 啟動：`./start.sh`（背景執行，log → `server.log`，pid → `server.pid`）
- 停止：`./stop.sh`（SIGTERM，先把資料寫入 `data/db.json` 再結束）
- 網址：http://127.0.0.1:8770/ （綁 0.0.0.0:8770；單機版仍在 python 8766）
- 健康檢查：http://127.0.0.1:8770/healthz
- 資料：`data/db.json`（原子寫入 .tmp → rename，並保留 `.bak`）；環境變數 `PORT`、`WZW_DATA` 可改埠號／資料夾
- GM 帳號：kokbot（第一次啟動時由 `../bot_account.txt` 的密碼建立，角色 kok／胡尼史）
- 不對外提供：`server/`、`*.txt`（含 bot 密碼）、`*.md/.sh/.py/.log`、隱藏檔

## Phase 2：伺服器權威魔物（2026-10-07）
- `gamelogic.js`：用 acorn＋vm 把 index.html 的遊戲邏輯載入伺服器（每大陸一份），地形／魔物生成／體型／狀態／傷害公式和用戶端同一份程式碼。
- `world.js`：魔物生成與重生（35–50 秒）、AI（史坎布雷被動；紅石／冰封 ❓→❗ 追最近的玩家、離開「該玩家畫面」就放棄回巢）、狀態／DoT／擊退、命中驗證（距離 ≤700+半徑、單發上限 普攻×20／技能×160 基礎攻擊、每秒總量、頻率）、擊殺分配（最後一擊拿金幣＋掉落；傷害 ≥20% 者按比例分 EXP）、地上掉落（最後一擊者優先 30 秒，1.5 秒後自動入袋）、死亡（伺服器擲骰掉裝→地上＋交易所、金幣減半）、GM 召喚／清除／無敵。
- 測試專用環境變數（正式伺服器不要設）：`WZW_TEST_DROPS=1`（必掉）、`WZW_TEST_DEBUG=1`（/debug）。
- 手機：鏡頭依螢幕自動縮放（＋／－／滾輪／雙指，存在 localStorage），虛擬搖桿、按住連打，HUD 小螢幕縮小，全螢幕按鈕；`manifest.webmanifest`＋圖示讓 iPhone「加入主畫面」後全螢幕開啟。
