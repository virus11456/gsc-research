# GSC 每日關鍵字機會

用 Google Search Console API 抓三站近 28 天 query，篩選（曝光 ≥ 5、排名 ≥ 8、排除品牌詞）、排序取前 30，跟全站文章比對分 NEW／REFRESH，寫成 `~/Documents/gsc-shared/<site>-latest.md`。Node 20+，不用裝套件。

## 金鑰

Service Account：`gsc-reader@simples-gsc.iam.gserviceaccount.com`（已加進三站 GSC，權限「限制」）。
金鑰放 `~/.config/gsc/service-account.json`（`chmod 600`），或用 `GSC_SA_KEY` 指定路徑。金鑰不要進 Git、不要貼到對話。

## 執行

```sh
node run.mjs                 # 三站
node run.mjs --site funday   # funday | elnido | luxstay | all
node run.mjs --dry-run       # 只算不寫檔
```

輸出資料夾用 `GSC_SHARED` 覆寫。stdout 最後一行是 JSON 摘要：

```json
{"date":"2026-11-09","sites":{"funday":{"new":2,"refresh":1,"posts":120,"queries":480,"file":"...","bytes":812}},"warnings":[]}
```

單站失敗不影響其他站，錯誤記在 `warnings`，結束碼非 0。NEW > 30 會警告 matching 可能失效。

## 測試

```sh
node --test test/*.test.mjs
```
