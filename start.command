#!/bin/zsh
# Double-click on macOS to start StringScope and open it in the browser.
cd "$(dirname "$0")"
(sleep 1 && open "http://localhost:5178") &
node server.js 5178
