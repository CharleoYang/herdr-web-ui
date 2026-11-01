### Fixed
- Panes show again on iOS 16.4 and later and on Safari 16.4 to 17.3, where every pane said
  "This pane can't be shown.": the app now brings its own `Promise.withResolvers` and
  `AbortSignal.any`, and its own `crypto.randomUUID` for a plain-http address.
