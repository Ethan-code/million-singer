# 歌曲與題庫放哪

歌曲和題庫放在 app 外面的資料夾，預設是：

- macOS：`~/Documents/MillionSinger`
- Windows：`文件\MillionSinger`

```
MillionSinger/
  songs/       音檔（mp3 等）
  playlists/   題庫 .json，題庫裡的 filename 指向 songs/ 內的檔名
```

第一次開啟 app 時會自動建立這個資料夾並放入範例。開始畫面下方可以「開啟」資料夾，或「變更」成其他位置（例如雲端硬碟、隨身碟）。

> 從舊版升級：舊版的歌曲和題庫在 app 內部，請把原本的 `songs/`、`playlists/` 內容複製到上面的資料夾。

# Mac
## 法一
請執行以下指令繞過檢查
```
sudo xattr -cr /path/to/百萬大歌星.app
```

> 把 App 拖進終端機就可以自動填入路徑

## 法二
或者比較簡單的方式：
1. 對著 App 按 右鍵。
2. 按住鍵盤的 Option (或 Control) 鍵不放。
3. 點選 「打開」。
4. 在跳出的視窗中再點一次 「打開」。