import { defineConfig } from 'wxt';

// WXT auto-generates the MV3 manifest from this config + the entrypoints/ dir.
// See https://wxt.dev
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  imports: false, // no auto-imports; we use explicit imports everywhere
  manifest: {
    name: 'Session Recorder by Proofline',
    description:
      'Record steps to reproduce a bug with screenshots, console logs and network requests. Export to Markdown or file a GitHub issue.',
    // All permissions the extension needs across every phase. Each is justified
    // in DEVELOPMENT.md. Host permissions are broad because the recorder must work on
    // any SaaS app the user points it at.
    permissions: [
      'sidePanel',
      'tabs',
      'scripting',
      'storage',
      'unlimitedStorage',
      'debugger',
      'offscreen',
      'tabCapture',
      'downloads',
      'webNavigation',
      'alarms',
    ],
    host_permissions: ['<all_urls>'],
    side_panel: {
      default_path: 'sidepanel/index.html',
    },
    action: {
      default_title: 'Session Recorder by Proofline',
      default_icon: {
        '16': 'icon/16.png',
        '32': 'icon/32.png',
        '48': 'icon/48.png',
        '128': 'icon/128.png',
      },
    },
    commands: {
      'toggle-annotation': {
        suggested_key: { default: 'Alt+Shift+A' },
        description: 'Toggle annotation mode on the recorded tab',
      },
      'add-marker': {
        suggested_key: { default: 'Alt+Shift+M' },
        description: 'Drop a marker at the current moment',
      },
      'capture-screenshot': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Take a screenshot of the recorded tab',
      },
      'toggle-pause': {
        suggested_key: { default: 'Alt+Shift+P' },
        description: 'Pause or resume recording',
      },
    },
  },
});
