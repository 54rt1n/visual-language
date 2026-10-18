export const operatingSystems = {
  windows: 'Windows', macos: 'macOS', ios: 'iPhone / iPad', android: 'Android', chromeos: 'ChromeOS', linux: 'Linux', unknown: 'Other / not detected',
} as const
export type OperatingSystem = keyof typeof operatingSystems
type BrowserInfo = { userAgent: string; platform?: string; maxTouchPoints?: number; userAgentData?: { platform?: string; brands?: readonly { brand: string }[] } }

/** Best-effort labels for instructions only; capability checks decide audio support. */
export function detectLanguageDevice(info: BrowserInfo) {
  const ua = info.userAgent, platform = info.userAgentData?.platform || info.platform || ''
  const os: OperatingSystem = /iPad|iPhone|iPod/i.test(ua) || (/Mac/i.test(platform + ua) && (info.maxTouchPoints ?? 0) > 1) ? 'ios'
    : /Android/i.test(platform + ua) ? 'android' : /CrOS|Chrome OS/i.test(platform + ua) ? 'chromeos'
      : /Win/i.test(platform + ua) ? 'windows' : /Mac/i.test(platform + ua) ? 'macos' : /Linux/i.test(platform + ua) ? 'linux' : 'unknown'
  const brands = info.userAgentData?.brands?.map(value => value.brand).join(' ') || ''
  const browser = /Edg(?:e|A|iOS)?\/|Microsoft Edge/i.test(ua + brands) ? 'Microsoft Edge'
    : /OPR\/|Opera|OPiOS/i.test(ua + brands) ? 'Opera'
      : /Firefox\/|FxiOS\//i.test(ua) ? 'Firefox'
        : /Chrome\/|CriOS\/|Google Chrome/i.test(ua + brands) ? 'Chrome / Chromium'
          : /Chromium/i.test(ua + brands) ? 'Chromium' : /Safari\//i.test(ua) ? 'Safari' : 'Unknown browser'
  return { os, browser }
}

// Official setup references checked 2026-09-11. No OS changes or downloads are
// initiated by the app; instructions stay available with the cached app offline.
export const languageSetupGuides: Record<OperatingSystem, { steps: string[]; source: string; sourceLabel: string }> = {
  windows: {
    steps: ['Open Windows Settings → Time & language → Speech.', 'Under Manage voices, choose Add voices and add Chinese (Simplified, China), or Chinese (Traditional, Taiwan) for Taiwan Mandarin. Wait for the speech download to finish.', 'Return here and choose Recheck voices. If it is still missing, close all browser windows, reopen the browser and try again.'],
    source: 'https://support.microsoft.com/en-us/accessibility/windows/narrator/appendix-a-supported-languages-and-voices', sourceLabel: 'Microsoft voice setup guide',
  },
  macos: {
    steps: ['Open System Settings → Accessibility → Read & Speak (Spoken Content on older macOS versions).', 'Open System voice and its voice management/info control. Find Chinese / Mandarin and download a voice.', 'Wait for the download, then return here and recheck. If needed, quit and reopen your browser.'],
    source: 'https://support.apple.com/guide/mac-help/change-the-voice-your-mac-uses-to-speak-text-mchlp2290/mac', sourceLabel: 'Apple Mac voice setup guide',
  },
  ios: {
    steps: ['Open Settings → Accessibility → Read & Speak (Spoken Content on older versions) → Voices.', 'Choose Chinese / Mandarin and download a voice for your preferred region.', 'Return to this page, recheck voices and tap Test Mandarin audio. Browser exposure of installed voices can vary.'],
    source: 'https://support.apple.com/en-ie/guide/iphone/iph96b214f0/ios', sourceLabel: 'Apple iPhone speech guide',
  },
  android: {
    steps: ['Search your device Settings for Text-to-speech output, usually under Accessibility.', 'Open the speech engine settings and Install voice data. Download Chinese / Mandarin; menu names depend on the device and engine.', 'Return here and recheck voices. Try the engine’s own Play sample if browser playback is still unavailable.'],
    source: 'https://support.google.com/accessibility/android/answer/6006983?hl=en', sourceLabel: 'Google Android speech guide',
  },
  chromeos: {
    steps: ['Open ChromeOS Settings → Accessibility → Text-to-speech → Text-to-speech voice settings.', 'Check the speech engine settings for a Chinese / Mandarin voice and download it if offered.', 'Return here and recheck. An online-only voice also needs an internet connection.'],
    source: 'https://support.google.com/accessibility/answer/11221616?hl=en', sourceLabel: 'Google ChromeOS speech guide',
  },
  linux: {
    steps: ['Check the speech engine and Mandarin voice packages available for your Linux distribution.', 'Firefox uses Speech Dispatcher; it must be installed and configured with a suitable voice. Other browser builds may expose a different voice list or none.', 'After configuring speech, restart the browser and recheck here. Installing a system voice does not guarantee that every browser can use it.'],
    source: 'https://support.mozilla.org/en-US/kb/speechd-setup', sourceLabel: 'Mozilla Linux speech setup guide',
  },
  unknown: {
    steps: ['Choose your operating system in the menu above if automatic detection is incorrect.', 'In your device’s speech or accessibility settings, look for a Chinese / Mandarin text-to-speech voice. A keyboard or display-language pack alone is not a speech voice.', 'Return here and recheck. The voice list below shows what this browser actually exposes, not every voice installed on the device.'],
    source: 'https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/getVoices', sourceLabel: 'How browser voice availability works',
  },
}
