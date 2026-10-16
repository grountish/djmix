const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // Automix timers must keep running while the window is hidden or minimised
      backgroundThrottling: false,
    },
    backgroundColor: '#1a1a2e',
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers

ipcMain.handle('dialog:openFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio Files', extensions: ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'aiff'] },
    ],
  });
  return result.filePaths;
});

ipcMain.handle('file:read', async (event, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    return buffer;
  } catch (error) {
    throw new Error(`Failed to read file: ${error.message}`);
  }
});

ipcMain.handle('file:getStats', async (event, filePath) => {
  try {
    const stats = fs.statSync(filePath);
    return {
      size: stats.size,
      mtime: stats.mtime.toISOString(),
    };
  } catch (error) {
    throw new Error(`Failed to get file stats: ${error.message}`);
  }
});

ipcMain.handle('cache:read', async (event, key) => {
  const cachePath = path.join(app.getPath('userData'), 'analysis-cache.json');
  try {
    if (fs.existsSync(cachePath)) {
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      return data[key] || null;
    }
  } catch (error) {
    console.error('Cache read error:', error);
  }
  return null;
});

ipcMain.handle('cache:write', async (event, key, value) => {
  const cachePath = path.join(app.getPath('userData'), 'analysis-cache.json');
  try {
    let data = {};
    if (fs.existsSync(cachePath)) {
      data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    }
    data[key] = value;
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error('Cache write error:', error);
    return false;
  }
});

ipcMain.handle('cache:readAll', async () => {
  const cachePath = path.join(app.getPath('userData'), 'analysis-cache.json');
  try {
    if (fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    }
  } catch (error) {
    console.error('Cache read error:', error);
  }
  return {};
});

ipcMain.handle('audio:getMetadata', async (event, filePath) => {
  try {
    const { parseFile } = require('music-metadata');
    const metadata = await parseFile(filePath);

    let artwork;
    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const picture = metadata.common.picture[0];
      const base64 = Buffer.from(picture.data).toString('base64');
      artwork = `data:${picture.format};base64,${base64}`;
    }

    return {
      artwork,
      artist: metadata.common.artist,
      title: metadata.common.title,
      album: metadata.common.album,
      tagKey: metadata.common.key,
      tagBpm: metadata.common.bpm,
    };
  } catch (error) {
    console.error('Metadata extraction error:', error);
    return {};
  }
});

// Track library persistence
ipcMain.handle('library:save', async (event, tracks) => {
  const libraryPath = path.join(app.getPath('userData'), 'track-library.json');
  try {
    // Save tracks without large waveform data to reduce file size
    const tracksToSave = tracks.map((track) => ({
      ...track,
      waveformData: undefined,
      spectralWaveform: undefined,
    }));
    fs.writeFileSync(libraryPath, JSON.stringify(tracksToSave, null, 2));
    return true;
  } catch (error) {
    console.error('Library save error:', error);
    return false;
  }
});

ipcMain.handle('library:load', async () => {
  const libraryPath = path.join(app.getPath('userData'), 'track-library.json');
  try {
    if (fs.existsSync(libraryPath)) {
      const tracks = JSON.parse(fs.readFileSync(libraryPath, 'utf-8'));
      // Filter out tracks whose files no longer exist
      const validTracks = tracks.filter((track) => {
        try {
          return fs.existsSync(track.filePath);
        } catch {
          return false;
        }
      });
      return validTracks;
    }
  } catch (error) {
    console.error('Library load error:', error);
  }
  return [];
});

ipcMain.handle('library:clear', async () => {
  const libraryPath = path.join(app.getPath('userData'), 'track-library.json');
  try {
    if (fs.existsSync(libraryPath)) {
      fs.unlinkSync(libraryPath);
    }
    return true;
  } catch (error) {
    console.error('Library clear error:', error);
    return false;
  }
});
