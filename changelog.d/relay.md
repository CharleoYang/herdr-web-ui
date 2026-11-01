### Added
- Remote access through the Ovis relay, off until you turn it on under **Settings → Phone &
  devices**: scan its QR code and the phone opens Ovis at app.ovis.sh, end-to-end encrypted to the
  PC, with no Tailscale, account or port forwarding. A phone pairs once with a pairing code and then
  proves itself with its own device key, never a token. Terminals, files, pictures, PDFs, seekable
  videos and push alerts work through it, and **Revoke** cuts a phone off at once. `pair` prints
  the relay's QR code too, and the iOS and Android apps open relay pairing links.
- Run your own relay with `bun relay/bun.ts` and `OVIS_RELAY_URL`, or host the app yourself with
  `OVIS_RELAY_APP_URL`.
- Each release attaches the hosted app it deploys to app.ovis.sh as `dist-shell.tar.gz` with its
  SHA-256, so anyone can compare the two. The user guide and docs/relay.md explain what
  relay.ovis.sh and app.ovis.sh can and can't see.
