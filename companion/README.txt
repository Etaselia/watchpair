WATCHPAIR COMPANION

Windows
1. Extract this ZIP to a folder you control.
2. Double-click install-and-start.cmd.
3. Leave its terminal window open while watching.
4. Return to WatchPair and press Connect.
5. Approve the website shown in the local pairing page.

The first launch downloads a private Node.js 24 runtime from nodejs.org when
Node is not already installed. Its SHA-256 checksum is verified before use.
It then installs the companion dependencies into this folder.

macOS / Linux
Install Node.js 22.13 or newer, then run:
  chmod +x install-and-start.sh
  ./install-and-start.sh

Downloads are saved in the downloads folder by default. The companion listens
only on 127.0.0.1:41735. Websites cannot use it until you explicitly approve
their origin on the local pairing page. Approved origins are stored in
~/.watchpair/companion.json.
