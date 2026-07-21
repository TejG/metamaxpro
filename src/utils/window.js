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
    let genieAnimating = false;

    // Easings. A genie should read as directional motion, not a symmetric
    // ease-in-out: collapsing "sucks in" (accelerate toward the point), and
    // restoring "pops out" (fast off the point, then settle). Expo curves give
    // that snap; cubic in/out is kept for the neutral default.
    function easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }
    function easeInExpo(t) {
        return t <= 0 ? 0 : Math.pow(2, 10 * (t - 1)); // accelerate into the point
    }
    function easeOutExpo(t) {
        return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); // burst out, then settle
    }

    // Animate a window's bounds + opacity from `from` to `to` over `durationMs`.
    // This approximates macOS's native "genie" minimize (shrink + fade toward a
    // point) cross-platform, since Electron doesn't expose the real Dock genie
    // effect to arbitrary windows.
    //
    // The interpolation is driven by the REAL elapsed clock, not a frame counter.
    // Each setBounds() on a full-size content window forces a synchronous reflow
    // that regularly overruns a 16ms budget; a frame-counted loop then stutters
    // (every backed-up tick advances the animation by one fixed step, so the
    // motion lurches and the total duration stretches). Time-based interpolation
    // self-corrects: a late tick simply lands at the position it *should* be at
    // for that moment, so the motion stays smooth and finishes on schedule even
    // when individual frames are dropped. `easing` lets callers pick the curve.
    function animateWindowGenie(win, from, to, durationMs, onDone, easing = easeInOutCubic) {
        if (!win || win.isDestroyed()) { if (onDone) onDone(); return; }

        try { win.setOpacity(from.opacity); } catch (_) {}
        try { win.setBounds({ x: Math.round(from.x), y: Math.round(from.y), width: Math.max(1, Math.round(from.width)), height: Math.max(1, Math.round(from.height)) }); } catch (_) {}

        const startedAt = Date.now();
        const finish = () => { if (onDone) onDone(); };

        const timer = setInterval(() => {
            if (win.isDestroyed()) { clearInterval(timer); finish(); return; }

            const raw = Math.min(1, (Date.now() - startedAt) / durationMs);
            const t = easing(raw);

            const x = from.x + (to.x - from.x) * t;
            const y = from.y + (to.y - from.y) * t;
            const width = from.width + (to.width - from.width) * t;
            const height = from.height + (to.height - from.height) * t;
            const opacity = from.opacity + (to.opacity - from.opacity) * t;

            try {
                win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) });
                win.setOpacity(Math.max(0, Math.min(1, opacity)));
            } catch (_) { /* window may have been closed mid-animation */ }

            if (raw >= 1) {
                clearInterval(timer);
                // Guarantee we land EXACTLY on the target (rounding during the
                // loop can leave us a pixel short of the final bounds/opacity).
                try {
                    win.setBounds({ x: Math.round(to.x), y: Math.round(to.y), width: Math.max(1, Math.round(to.width)), height: Math.max(1, Math.round(to.height)) });
                    win.setOpacity(Math.max(0, Math.min(1, to.opacity)));
                } catch (_) {}
                finish();
            }
        }, 1000 / 120); // tick at up to ~120fps; time-based math keeps it correct on any display
    }

    // Fixed target position/size for the mascot (bottom-left corner) — used both
    // to place the mascot window and as the genie animation's collapse point.
    function getMascotTargetBounds() {
        const winW = 220;
        const winH = 170;
        const primaryDisplay = screen.getPrimaryDisplay();
        const { height: shgt } = primaryDisplay.workAreaSize;
        return { x: 24, y: shgt - winH - 24, width: winW, height: winH };
    }

    // `fromBounds` (optional) lets the caller genie-animate the mascot growing
    // in from a specific point (e.g. where the main window shrank to) instead of
    // just popping in at full size.
    function showMascot(fromBounds = null) {
        if (mascotWindow && !mascotWindow.isDestroyed()) {
            mascotWindow.showInactive();
            return;
        }

        const target = getMascotTargetBounds();
        const start = fromBounds || { ...target, opacity: 0 };

        mascotWindow = new BrowserWindow({
            width: Math.max(1, Math.round(start.width)),
            height: Math.max(1, Math.round(start.height)),
            x: Math.round(start.x),
            y: Math.round(start.y),
            frame: false,
            transparent: true,
            alwaysOnTop: true,
            resizable: false,
            hasShadow: false,
            skipTaskbar: true,
            opacity: fromBounds ? (fromBounds.opacity ?? 0) : 0,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
            },
        });
        mascotWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        mascotWindow.loadFile(path.join(__dirname, '../mascot.html'));
        mascotWindow.on('closed', () => { mascotWindow = null; });

        // Genie "un-collapse": grow from the shrink point up to full mascot size
        // while fading in, once content has painted.
        mascotWindow.once('ready-to-show', () => {
            animateWindowGenie(
                mascotWindow,
                { ...start, opacity: fromBounds ? (fromBounds.opacity ?? 0) : 0 },
                { ...target, opacity: 1 },
                240,
                null,
                easeOutExpo // pop out of the collapse point, then settle
            );
        });
    }

    // `toBounds` (optional) lets the caller genie-animate the mascot shrinking
    // toward a specific point (e.g. where the main window will grow back from)
    // before actually closing it, instead of just vanishing instantly.
    function hideMascot(toBounds = null, onDone = null) {
        if (!mascotWindow || mascotWindow.isDestroyed()) {
            mascotWindow = null;
            if (onDone) onDone();
            return;
        }
        if (!toBounds) {
            mascotWindow.close();
            mascotWindow = null;
            if (onDone) onDone();
            return;
        }
        const target = getMascotTargetBounds();
        const win = mascotWindow;
        animateWindowGenie(
            win,
            { ...target, opacity: 1 },
            { ...toBounds, opacity: 0 },
            200,
            () => {
                if (!win.isDestroyed()) win.close();
                mascotWindow = null;
                if (onDone) onDone();
            },
            easeInExpo // accelerate as the mascot is sucked into the point
        );
    }

    ipcMain.handle('minimize-to-mascot', () => {
        if (mainWindow.isDestroyed() || genieAnimating) return { success: false };
        genieAnimating = true;

        const originalBounds = mainWindow.getBounds();
        const target = getMascotTargetBounds();
        // Collapse the main window down into the mascot's target rect while
        // fading it out — the "genie" shrink toward where the mascot will appear.
        const collapsedBounds = {
            x: target.x + target.width / 2 - 2,
            y: target.y + target.height / 2 - 2,
            width: 4,
            height: 4,
        };

        // The window normally enforces a ~100x150 minimum size, which would
        // clamp the shrink animation well before it reaches the collapse point.
        // Relax it for the duration of the animation, then restore afterward.
        try { mainWindow.setMinimumSize(1, 1); } catch (_) {}

        animateWindowGenie(
            mainWindow,
            { ...originalBounds, opacity: 1 },
            { ...collapsedBounds, opacity: 0 },
            240,
            () => {
                if (!mainWindow.isDestroyed()) {
                    mainWindow.hide(); // hidden entirely — never in the taskbar
                    // Restore bounds/opacity/min-size now while invisible, so
                    // it's ready to animate back in correctly next time.
                    try { mainWindow.setBounds(originalBounds); } catch (_) {}
                    try { mainWindow.setOpacity(1); } catch (_) {}
                    try { mainWindow.setMinimumSize(Math.min(originalBounds.width, 100), Math.min(originalBounds.height, 150)); } catch (_) {}
                }
                // Grow the mascot in from that same collapsed point for a
                // continuous, single genie motion instead of two disjoint ones.
                showMascot({ ...collapsedBounds, opacity: 0 });
                genieAnimating = false;
            },
            easeInExpo // accelerate as the window is sucked into the point
        );
        return { success: true };
    });

    ipcMain.handle('restore-from-mascot', () => {
        if (genieAnimating) return { success: false };
        genieAnimating = true;

        const target = getMascotTargetBounds();
        const restoreBounds = mainWindow.isDestroyed() ? target : mainWindow.getBounds();
        const collapsedBounds = {
            x: target.x + target.width / 2 - 2,
            y: target.y + target.height / 2 - 2,
            width: 4,
            height: 4,
        };

        // Shrink the mascot back down to that point, then grow the main window
        // out from it — the reverse genie motion, restoring the window.
        hideMascot(collapsedBounds, () => {
            if (mainWindow.isDestroyed()) { genieAnimating = false; return; }
            try { mainWindow.setMinimumSize(1, 1); } catch (_) {}
            mainWindow.show();
            mainWindow.focus();
            animateWindowGenie(
                mainWindow,
                { ...collapsedBounds, opacity: 0 },
                { ...restoreBounds, opacity: 1 },
                240,
                () => {
                    try { mainWindow.setMinimumSize(Math.min(restoreBounds.width, 100), Math.min(restoreBounds.height, 150)); } catch (_) {}
                    genieAnimating = false;
                },
                easeOutExpo // burst out of the point, then settle into place
            );
        });
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
