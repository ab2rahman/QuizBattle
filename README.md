# QuizBattle (local test)

This is a small static demo for a real-time Quiz Battle using Firebase Realtime Database.

Files changed/added:
- `index2.html` — updated to use Firebase modular SDK with a small compat shim and to load `firebase-config.json` when present.
- `firebase-config.json` — (optional) contains your Firebase project config. If missing, `index2.html` falls back to the inline config.

Quick testing steps (Windows PowerShell):

1. (Optional) Replace `firebase-config.json` with your project's config. The file should contain the same keys as in this repo.

2. Start a simple static file server from the project folder. If you have Python installed:

```powershell
# From project root (d:\Web Project\QuizBattle)
python -m http.server 8000
```

Or use Node (if you have http-server):

```powershell
npx http-server -p 8000
```

3. Open the host view in a laptop browser:

http://localhost:8000/index2.html

Click "Saya Host" then "Buat Game Baru". Share the PIN shown.

4. On a second device (or another browser/incognito), open the same URL and click "Saya Peserta". Enter a name and the PIN to join.

5. From the host panel, click "Mulai Quiz". Participants will see questions. Use "Reveal Answer & Score" from host to compute scores.

Notes:
- The demo uses Firebase Realtime Database. Ensure your Firebase rules allow read/write for testing, or configure proper auth.
- If you see CORS errors when loading `firebase-config.json`, ensure you serve files over HTTP (not file://) using a local server.
- The modular shim keeps the rest of the inline code mostly unchanged; it's a small compatibility layer.

Troubleshooting:
- If Firebase doesn't initialize, check the browser console for errors and verify `firebase-config.json` contents.
- To use your own Firebase project, copy the config object from Firebase console and replace `firebase-config.json`.

