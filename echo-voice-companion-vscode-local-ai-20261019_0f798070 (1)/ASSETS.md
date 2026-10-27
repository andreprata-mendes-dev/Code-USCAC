# Asset source notes

The site uses **Atkinson Hyperlegible Next**, the typeface selected in the approved Soft Signal blueprint. Its web CSS is loaded from the Google Fonts CSS API at `https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@400;500;600;700&display=swap`. The typeface source and web-font availability are documented by the Braille Institute at <https://www.brailleinstitute.org/freefont/>. The CSS stack includes system sans-serif fallbacks if the remote font cannot load.

The small site icon is the purpose-built heart-and-soundwave SVG in `public/logo.svg`; the wordmark and in-app waveform use the existing icon font and CSS. The platform's literal logo URL is recorded in `app.config.ts`. The website does not require stock or generated photos.

The in-app voice setup notes link to official operating-system guidance: <https://support.microsoft.com/en-us/accessibility/windows/narrator/appendix-a-supported-languages-and-voices>, <https://support.apple.com/en-ca/guide/mac-help/mh27448/mac>, and <https://support.google.com/accessibility/android/answer/6006983?hl=en>. Echo itself only lists voices exposed by the visitor's browser; it cannot install voices.
