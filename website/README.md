# stackmoor.dev

The project website: plain HTML and CSS, no build step. Open `index.html` through any static server, e.g.:

```bash
cd website && python3 -m http.server 8000
```

Pushing changes to `main` publishes the folder to GitHub Pages (`.github/workflows/website.yml`).

- Fonts: IBM Plex Sans and IBM Plex Mono, self-hosted (SIL Open Font License, `assets/fonts/OFL.txt`) – no requests to Google.
- `og.png` is the preview image for links shared on social media.
