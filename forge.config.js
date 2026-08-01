const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
    packagerConfig: {
        asar: {
            unpack: '**/{onnxruntime-node,onnxruntime-common,@huggingface/transformers,sharp,@img}/**',
        },
        extraResource: ['./src/assets/SystemAudioDump'],
        name: 'MetaQuest',
        // Keep the packaged app lean: exclude dev/test/docs artifacts that
        // ballooned app size. node_modules is handled by forge's pruning,
        // plus targeted rules below for oversized optional payloads:
        // - onnxruntime-web (91MB): transformers.js pulls it in, but Electron
        //   main always uses the onnxruntime-node backend.
        // - onnxruntime-node binaries for OTHER platforms (~140MB): each
        //   platform build only needs its own napi binary.
        // - tesseract.js-core non-LSTM wasm variants (~20MB): node worker
        //   only ever loads the (relaxed)simd-lstm builds.
        ignore: (() => {
            const platform = process.platform; // darwin | win32 | linux
            const otherPlatforms = ['darwin', 'win32', 'linux'].filter(p => p !== platform);
            return [
                /^\/scripts($|\/)/,
                /^\/memory($|\/)/,
                /^\/\.git($|\/)/,
                /^\/\.vscode($|\/)/,
                /\.md$/i,
                /^\/eng\.traineddata$/, // tesseract downloads its own language data at runtime
                /^\/entitlements\.plist$/,
                /\.(bak|tmp|log)$/i,
                /^\/node_modules\/onnxruntime-web($|\/)/,
                ...otherPlatforms.map(p => new RegExp(`^/node_modules/onnxruntime-node/bin/napi-v3/${p}($|/)`)),
                // Drop tesseract core variants the node worker never loads
                // (keeps tesseract-core-simd-lstm* and tesseract-core-relaxedsimd-lstm*).
                /^\/node_modules\/tesseract\.js-core\/tesseract-core(-simd|-relaxedsimd)?\.wasm(\.js)?$/,
                /^\/node_modules\/tesseract\.js-core\/tesseract-core-lstm\.wasm(\.js)?$/,
            ];
        })(),
    icon: 'src/assets/logo',
    // Stable bundle identifier — TCC (mic / screen recording) keys permissions
    // off this, so it must be set and constant across releases.
    appBundleId: 'com.metaquest.app',
    // Build for both Apple Silicon (arm64) and Intel (x64) Macs
    arch: ['x64', 'arm64'],
        // macOS requires these usage-description strings in Info.plist or it
        // will deny (and can crash) the app when it requests mic/camera access.
        extendInfo: {
            NSMicrophoneUsageDescription: 'MetaQuest uses the microphone to hear your questions and provide live answers during interviews.',
            NSCameraUsageDescription: 'MetaQuest may use the camera for video-based assistance.',
        },
        // use `security find-identity -v -p codesigning` to find your identity
        // for macos signing
        // also fuck apple
        // osxSign: {
        //    identity: '<paste your identity here>',
        //   optionsForFile: (filePath) => {
        //       return {
        //           entitlements: 'entitlements.plist',
        //       };
        //   },
        // },
        // notarize if off cuz i ran this for 6 hours and it still didnt finish
        // osxNotarize: {
        //    appleId: 'your apple id',
        //    appleIdPassword: 'app specific password',
        //    teamId: 'your team id',
        // },
    },
    rebuildConfig: {},
    makers: [
        {
            name: '@electron-forge/maker-squirrel',
            config: {
                name: 'metaquest',
                productName: 'MetaQuest',
                shortcutName: 'MetaQuest',
                createDesktopShortcut: true,
                createStartMenuShortcut: true,
            },
        },
        {
            name: '@electron-forge/maker-dmg',
            platforms: ['darwin'],
        },
        {
            // Required for macOS in-app auto-update: Squirrel.Mac downloads a
            // .zip of the .app (the .dmg is only for first-time manual install).
            name: '@electron-forge/maker-zip',
            platforms: ['darwin'],
        },
        {
            name: '@reforged/maker-appimage',
            platforms: ['linux'],
            config: {
                options: {
                    name: 'MetaQuest',
                    productName: 'MetaQuest',
                    genericName: 'AI Assistant',
                    description: 'AI assistant for interviews and learning',
                    categories: ['Development', 'Education'],
                    icon: 'src/assets/logo.png'
                }
            },
        },
    ],
    plugins: [
        {
            name: '@electron-forge/plugin-auto-unpack-natives',
            config: {},
        },
        // Fuses are used to enable/disable various Electron functionality
        // at package time, before code signing the application
        new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true,
        }),
    ],
};
