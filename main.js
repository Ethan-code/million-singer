const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 720,
        // 隱藏選單列 (讓它看起來更像遊戲)
        autoHideMenuBar: true, 
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            // 關鍵！關閉網頁安全檢查，允許讀取本機檔案
            webSecurity: false 
        }
    });

    win.loadFile('index.html');
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});