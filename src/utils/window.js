const { BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('node:path');
const storage = require('../storage');

let mouseEventsIgnored = false;

// Single source of truth for app window sizing
const WINDOW_SIZES = {
    normal: { width: 900, height: 650 },
    live: { width: 850, height: 400 },
};

function getMainWindowSizeByView(view = 'main') {
    return view === 'assistant' ? WINDOW_SIZES.live : WINDOW_SIZES.normal;
}

function applyMainWindowSize(mainWindow, view = 'main') {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const { width, height } = getMainWindowSizeByView(view);
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth } = primaryDisplay.workAreaSize;
    const x = Math.floor((screenWidth - width) / 2);

    mainWindow.setSize(width, height);
    mainWindow.setPosition(x, 0);

    // Ensure the window can still be resized by users, but starts from our intended size.
    mainWindow.setMinimumSize(Math.min(width, 100), Math.min(height, 150));
}

function createWindow(sendToRenderer, geminiSessionRef) {
    // Get layout preference (default to 'normal')
    let windowWidth = WINDOW_SIZES.normal.width;
    let windowHeight = WINDOW_SIZES.normal.height;

    const mainWindow = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        frame: false,
        // On Windows a frameless window needs a thickFrame to allow native resizing
        thickFrame: process.platform === 'win32',
        transparent: true,
        hasShadow: false,
        alwaysOnTop: true,
        resizable: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false, // TODO: change to true
            backgroundThrottling: false,
            enableBlinkFeatures: 'GetDisplayMedia',
            webSecurity: true,
            allowRunningInsecureContent: false,
        },
        backgroundColor: '#00000000',
    });

    const { session, desktopCapturer } = require('electron');

    // Allow camera + mic permission requests from the renderer
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        const allowed = ['media', 'camera', 'microphone', 'mediaKeySystem'];
        callback(allowed.includes(permission));
    });

    // Handle display media (screen capture) requests. This is called when the
    // renderer uses navigator.mediaDevices.getDisplayMedia(). On macOS, this
    // requires Screen Recording permission to be granted in System Settings.
    // The first call to desktopCapturer.getSources() will trigger the macOS
    // permission prompt if not already granted.
    session.defaultSession.setDisplayMediaRequestHandler(
        (request, callback) => {
            desktopCapturer.getSources({ types: ['screen'] })
                .then(sources => {
                    if (sources && sources.length > 0) {
                        callback({ video: sources[0], audio: 'loopback' });
                    } else {
                        console.error('[Screen Capture] No screen sources available');
                        callback({});
                    }
                })
                .catch(error => {
                    console.error('[Screen Capture] Failed to get sources:', error);
                    callback({});
                });
        },
        // On Windows, useSystemPicker bypasses our loopback audio injection — disable it
        { useSystemPicker: process.platform !== 'win32' }
    );

    // Keep the window resizable so programmatic and user-initiated size changes work
    mainWindow.setResizable(true);
    mainWindow.setContentProtection(true);
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Hide from Windows taskbar
    if (process.platform === 'win32') {
        try {
            mainWindow.setSkipTaskbar(true);
        } catch (error) {
            console.warn('Could not hide from taskbar:', error.message);
        }
    }

    // Hide from Mission Control on macOS
    if (process.platform === 'darwin') {
        try {
            mainWindow.setHiddenInMissionControl(true);
        } catch (error) {
            console.warn('Could not hide from Mission Control:', error.message);
        }
    }

    // Center window at the top of the screen
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth } = primaryDisplay.workAreaSize;
    const x = Math.floor((screenWidth - windowWidth) / 2);
    const y = 0;
    mainWindow.setPosition(x, y);

    if (process.platform === 'win32') {
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    }

    mainWindow.loadFile(path.join(__dirname, '../index.html'));

    // Re-apply intended startup size once the window is fully ready.
    // This avoids stale OS-restored bounds making the launch size appear unchanged.
    mainWindow.once('ready-to-show', () => {
        applyMainWindowSize(mainWindow, 'main');
    });

    // After window is created, initialize keybinds
    mainWindow.webContents.once('dom-ready', () => {
        setTimeout(() => {
            const defaultKeybinds = getDefaultKeybinds();
            let keybinds = defaultKeybinds;

            // Load keybinds from storage
            const savedKeybinds = storage.getKeybinds();
            if (savedKeybinds) {
                keybinds = { ...defaultKeybinds, ...savedKeybinds };
            }

            updateGlobalShortcuts(keybinds, mainWindow, sendToRenderer, geminiSessionRef);
        }, 150);
    });

    setupWindowIpcHandlers(mainWindow, sendToRenderer, geminiSessionRef);

    return mainWindow;
}

function getDefaultKeybinds() {
    // Use CommandOrControl so accelerators are consistent across platforms
    const primary = 'CommandOrControl';
    return {
        moveUp: `Alt+Up`,
        moveDown: `Alt+Down`,
        moveLeft: `Alt+Left`,
        moveRight: `Alt+Right`,
        toggleVisibility: `${primary}+\\`,
        toggleClickThrough: `${primary}+M`,
        nextStep: `${primary}+Enter`,
        addScreen: `${primary}+Shift+Enter`,
        previousResponse: `${primary}+[`,
        nextResponse: `${primary}+]`,
        scrollUp: `${primary}+Shift+Up`,
        scrollDown: `${primary}+Shift+Down`,
        emergencyErase: `${primary}+Shift+E`,
    };
}

function updateGlobalShortcuts(keybinds, mainWindow, sendToRenderer, geminiSessionRef) {
    console.log('Updating global shortcuts with:', keybinds);

    // Unregister all existing shortcuts
    globalShortcut.unregisterAll();

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    const moveIncrement = Math.floor(Math.min(width, height) * 0.1);

    // Register window movement shortcuts
    const movementActions = {
        moveUp: () => {
            if (!mainWindow.isVisible()) return;
            const [currentX, currentY] = mainWindow.getPosition();
            mainWindow.setPosition(currentX, currentY - moveIncrement);
        },
        moveDown: () => {
            if (!mainWindow.isVisible()) return;
            const [currentX, currentY] = mainWindow.getPosition();
            mainWindow.setPosition(currentX, currentY + moveIncrement);
        },
        moveLeft: () => {
            if (!mainWindow.isVisible()) return;
            const [currentX, currentY] = mainWindow.getPosition();
            mainWindow.setPosition(currentX - moveIncrement, currentY);
        },
        moveRight: () => {
            if (!mainWindow.isVisible()) return;
            const [currentX, currentY] = mainWindow.getPosition();
            mainWindow.setPosition(currentX + moveIncrement, currentY);
        },
    };

    // Register each movement shortcut
    Object.keys(movementActions).forEach(action => {
        const keybind = keybinds[action];
        if (keybind) {
            try {
                globalShortcut.register(keybind, movementActions[action]);
                console.log(`Registered ${action}: ${keybind}`);
            } catch (error) {
                console.error(`Failed to register ${action} (${keybind}):`, error);
            }
        }
    });

    // Register toggle visibility shortcut
    if (keybinds.toggleVisibility) {
        try {
            globalShortcut.register(keybinds.toggleVisibility, () => {
                if (mainWindow.isVisible()) {
                    mainWindow.hide();
                } else {
                    mainWindow.showInactive();
                }
            });
            console.log(`Registered toggleVisibility: ${keybinds.toggleVisibility}`);
        } catch (error) {
            console.error(`Failed to register toggleVisibility (${keybinds.toggleVisibility}):`, error);
        }
    }

    // Register toggle click-through shortcut
    if (keybinds.toggleClickThrough) {
        try {
            globalShortcut.register(keybinds.toggleClickThrough, () => {
                mouseEventsIgnored = !mouseEventsIgnored;
                if (mouseEventsIgnored) {
                    mainWindow.setIgnoreMouseEvents(true, { forward: true });
                    console.log('Mouse events ignored');
                } else {
                    mainWindow.setIgnoreMouseEvents(false);
                    console.log('Mouse events enabled');
                }
                mainWindow.webContents.send('click-through-toggled', mouseEventsIgnored);
            });
            console.log(`Registered toggleClickThrough: ${keybinds.toggleClickThrough}`);
        } catch (error) {
            console.error(`Failed to register toggleClickThrough (${keybinds.toggleClickThrough}):`, error);
        }
    }

    // Register next step shortcut. In the main view it starts the session;
    // in the assistant view it means "answer now" — analyse the buffered
    // screens if any were added, otherwise grab and analyse the current frame.
    if (keybinds.nextStep) {
        try {
            globalShortcut.register(keybinds.nextStep, async () => {
                console.log('Next step shortcut triggered');
                try {
                    // Determine the shortcut key format
                    const isMac = process.platform === 'darwin';
                    const shortcutKey = isMac ? 'cmd+enter' : 'ctrl+enter';

                    // Use the new handleShortcut function
                    mainWindow.webContents.executeJavaScript(`
                        metaMaxPro.handleShortcut('${shortcutKey}');
                    `);
                } catch (error) {
                    console.error('Error handling next step shortcut:', error);
                }
            });
            console.log(`Registered nextStep: ${keybinds.nextStep}`);
        } catch (error) {
            console.error(`Failed to register nextStep (${keybinds.nextStep}):`, error);
        }
    }

    // Register add-screen shortcut — adds the current screen to the capture
    // buffer without analysing yet, so a long/multi-screen question can be
    // stitched together (scroll → add → scroll → add → nextStep to answer).
    if (keybinds.addScreen) {
        try {
            globalShortcut.register(keybinds.addScreen, () => {
                console.log('Add-screen shortcut triggered');
                try {
                    mainWindow.webContents.executeJavaScript(`
                        metaMaxPro.handleShortcut('add-screen');
                    `);
                } catch (error) {
                    console.error('Error handling add-screen shortcut:', error);
                }
            });
            console.log(`Registered addScreen: ${keybinds.addScreen}`);
        } catch (error) {
            console.error(`Failed to register addScreen (${keybinds.addScreen}):`, error);
        }
    }

    // Register previous response shortcut
    if (keybinds.previousResponse) {
        try {
            globalShortcut.register(keybinds.previousResponse, () => {
                console.log('Previous response shortcut triggered');
                sendToRenderer('navigate-previous-response');
            });
            console.log(`Registered previousResponse: ${keybinds.previousResponse}`);
        } catch (error) {
            console.error(`Failed to register previousResponse (${keybinds.previousResponse}):`, error);
        }
    }

    // Register next response shortcut
    if (keybinds.nextResponse) {
        try {
            globalShortcut.register(keybinds.nextResponse, () => {
                console.log('Next response shortcut triggered');
                sendToRenderer('navigate-next-response');
            });
            console.log(`Registered nextResponse: ${keybinds.nextResponse}`);
        } catch (error) {
            console.error(`Failed to register nextResponse (${keybinds.nextResponse}):`, error);
        }
    }

    // Register scroll up shortcut
    if (keybinds.scrollUp) {
        try {
            globalShortcut.register(keybinds.scrollUp, () => {
                console.log('Scroll up shortcut triggered');
                sendToRenderer('scroll-response-up');
            });
            console.log(`Registered scrollUp: ${keybinds.scrollUp}`);
        } catch (error) {
            console.error(`Failed to register scrollUp (${keybinds.scrollUp}):`, error);
        }
    }

    // Register scroll down shortcut
    if (keybinds.scrollDown) {
        try {
            globalShortcut.register(keybinds.scrollDown, () => {
                console.log('Scroll down shortcut triggered');
                sendToRenderer('scroll-response-down');
            });
            console.log(`Registered scrollDown: ${keybinds.scrollDown}`);
        } catch (error) {
            console.error(`Failed to register scrollDown (${keybinds.scrollDown}):`, error);
        }
    }

    // Register emergency erase shortcut
    if (keybinds.emergencyErase) {
        try {
            globalShortcut.register(keybinds.emergencyErase, () => {
                console.log('Emergency Erase triggered!');
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.hide();

                    if (geminiSessionRef.current) {
                        geminiSessionRef.current.close();
                        geminiSessionRef.current = null;
                    }

                    sendToRenderer('clear-sensitive-data');

                    setTimeout(() => {
                        const { app } = require('electron');
                        app.quit();
                    }, 300);
                }
            });
            console.log(`Registered emergencyErase: ${keybinds.emergencyErase}`);
        } catch (error) {
            console.error(`Failed to register emergencyErase (${keybinds.emergencyErase}):`, error);
        }
    }
}

function setupWindowIpcHandlers(mainWindow, sendToRenderer, geminiSessionRef) {
    // ── Teleprompter Window ─────────────────────────────────────
    let teleprompterWindow = null;
    let currentView = 'main';

    ipcMain.on('open-gaze-window', () => {
        if (teleprompterWindow && !teleprompterWindow.isDestroyed()) {
            teleprompterWindow.focus();
            return;
        }

        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: sw } = primaryDisplay.workAreaSize;
        const winW = 480;
        const winH = 160;

        teleprompterWindow = new BrowserWindow({
            width: winW,
            height: winH,
            x: Math.floor((sw - winW) / 2),
            y: 0,                          // top of screen — right below webcam
            frame: false,
            transparent: true,
            alwaysOnTop: true,
            resizable: true,
            hasShadow: false,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
            },
        });

        teleprompterWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        teleprompterWindow.loadFile(path.join(__dirname, '../teleprompter.html'));

        teleprompterWindow.on('closed', () => {
            teleprompterWindow = null;
            if (!mainWindow.isDestroyed()) {
                mainWindow.webContents.send('gaze-window-closed');
            }
        });
    });

    ipcMain.on('close-gaze-window', () => {
        if (teleprompterWindow && !teleprompterWindow.isDestroyed()) {
            teleprompterWindow.close();
        }
    });

    // Forward the latest AI response text to the teleprompter window
    ipcMain.on('teleprompter-update', (event, text) => {
        if (teleprompterWindow && !teleprompterWindow.isDestroyed()) {
            teleprompterWindow.webContents.send('teleprompter-update', text);
        }
    });

    // ── Minimize-to-mascot ──────────────────────────────────────
    // Instead of sitting in the taskbar, "minimize" hides the main window and
    // shows a small always-on-top mascot the user can drag and click to restore.
    let mascotWindow = null;

    function showMascot() {
        if (mascotWindow && !mascotWindow.isDestroyed()) {
            mascotWindow.showInactive();
            return;
        }
        // Extra width/height leaves room for the speech bubble above the mascot.
        const winW = 220;
        const winH = 170;
        const primaryDisplay = screen.getPrimaryDisplay();
        const { height: shgt } = primaryDisplay.workAreaSize;

        mascotWindow = new BrowserWindow({
            width: winW,
            height: winH,
            x: 24,                    // bottom-left corner
            y: shgt - winH - 24,
            frame: false,
            transparent: true,
            alwaysOnTop: true,
            resizable: false,
            hasShadow: false,
            skipTaskbar: true,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
            },
        });
        mascotWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        mascotWindow.loadFile(path.join(__dirname, '../mascot.html'));
        mascotWindow.on('closed', () => { mascotWindow = null; });
    }

    function hideMascot() {
        if (mascotWindow && !mascotWindow.isDestroyed()) {
            mascotWindow.close();
        }
        mascotWindow = null;
    }

    ipcMain.handle('minimize-to-mascot', () => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.hide(); // hidden entirely — never in the taskbar
        }
        showMascot();
        return { success: true };
    });

    ipcMain.handle('restore-from-mascot', () => {
        hideMascot();
        if (!mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
        }
        return { success: true };
    });

    // Move the mascot window as the user drags it (relative deltas from renderer)
    ipcMain.on('mascot-drag', (event, delta) => {
        if (mascotWindow && !mascotWindow.isDestroyed() && delta) {
            const [x, y] = mascotWindow.getPosition();
            mascotWindow.setPosition(Math.round(x + (delta.dx || 0)), Math.round(y + (delta.dy || 0)));
        }
    });

    // ── View / layout changes ───────────────────────────────────
    // Re-apply the always-on-top overlay behaviour used everywhere except
    // onboarding (screen-saver level on Windows, floating on macOS).
    const restoreOverlayMode = win => {
        try { win.setAlwaysOnTop(true, process.platform === 'win32' ? 'screen-saver' : 'floating', 1); } catch (_) { win.setAlwaysOnTop(true); }
        try { win.setContentProtection(true); } catch (_) {}
        try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
    };

    ipcMain.on('view-changed', (event, view) => {
        if (!mainWindow.isDestroyed()) {
            currentView = view || 'main';

            if (view === 'onboarding') {
                // Onboarding requires the user to reach System Settings and the
                // native permission prompts. A screen-saver-level, always-on-top,
                // content-protected overlay covers those dialogs and can't be
                // dragged aside — so while onboarding, drop to a normal, movable,
                // non-topmost window that the user can move out of the way.
                applyMainWindowSize(mainWindow, 'main');
                mainWindow.setIgnoreMouseEvents(false);
                try { mainWindow.setAlwaysOnTop(false); } catch (_) {}
                try { mainWindow.setContentProtection(false); } catch (_) {}
                try { mainWindow.setVisibleOnAllWorkspaces(false); } catch (_) {}
                try { mainWindow.setMovable(true); } catch (_) {}
                mainWindow.focus();
            } else if (view === 'assistant') {
                restoreOverlayMode(mainWindow);
                // Shrink window for live view
                applyMainWindowSize(mainWindow, 'assistant');
            } else {
                restoreOverlayMode(mainWindow);
                // Restore full size
                applyMainWindowSize(mainWindow, 'main');
                mainWindow.setIgnoreMouseEvents(false);
            }
        }
    });

    ipcMain.handle('window-minimize', () => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.minimize();
        }
    });

    ipcMain.on('update-keybinds', (event, newKeybinds) => {
        if (!mainWindow.isDestroyed()) {
            updateGlobalShortcuts(newKeybinds, mainWindow, sendToRenderer, geminiSessionRef);
        }
    });

    ipcMain.handle('toggle-window-visibility', async event => {
        try {
            if (mainWindow.isDestroyed()) {
                return { success: false, error: 'Window has been destroyed' };
            }

            if (mainWindow.isVisible()) {
                mainWindow.hide();
            } else {
                mainWindow.showInactive();
            }
            return { success: true };
        } catch (error) {
            console.error('Error toggling window visibility:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('update-sizes', async event => {
        // Re-apply current view size to keep renderer-side layout updates in sync
        // with the actual BrowserWindow dimensions.
        applyMainWindowSize(mainWindow, currentView);
        return { success: true };
    });
}

module.exports = {
    createWindow,
    getDefaultKeybinds,
    updateGlobalShortcuts,
    setupWindowIpcHandlers,
};
